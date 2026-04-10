//! 实现音频转写工具，支持在线接口和本地 Python 脚本两种路径。

use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use reqwest::{multipart, Client};
use serde_json::{json, Value};

use crate::{
    assets::get_asset,
    constants::{ALIYUN_DASHSCOPE_AUDIO_MODEL, AUDIO_TRANSCRIBE_SCRIPT_RELATIVE_PATH},
    env::{
        load_aliyun_fallback_config, load_provider_config_with_model_override,
        online_uses_aliyun_fallback, read_env_or_default, read_env_var,
    },
    llm::{build_chat_completions_url, build_request_headers, extract_response_error},
    models::{AgentMode, AssetKind, TranscribeAudioRequest},
    python::run_python_script,
    skills::project_root_candidates,
};

/// 查找本地音频转写脚本。
fn audio_transcribe_script_path() -> Option<PathBuf> {
    let candidates = project_root_candidates()
        .into_iter()
        .map(|root| root.join(AUDIO_TRANSCRIBE_SCRIPT_RELATIVE_PATH))
        .collect::<Vec<_>>();

    if let Some(existing_path) = candidates.iter().find(|candidate| candidate.exists()) {
        return Some(existing_path.clone());
    }

    candidates.into_iter().next()
}

/// 构建在线转写接口地址。
fn build_audio_transcriptions_url(base_url: &str) -> String {
    format!("{}/audio/transcriptions", base_url.trim_end_matches('/'))
}

/// 将 MIME 类型映射为阿里云兼容输入所需的音频格式。
fn audio_format_from_asset(asset: &crate::assets::StoredAsset) -> String {
    let mime = asset.mime_type.to_ascii_lowercase();

    if mime.contains("mpeg") || asset.display_name.to_ascii_lowercase().ends_with(".mp3") {
        return "mp3".to_string();
    }

    if mime.contains("wav") || asset.display_name.to_ascii_lowercase().ends_with(".wav") {
        return "wav".to_string();
    }

    if mime.contains("m4a") || asset.display_name.to_ascii_lowercase().ends_with(".m4a") {
        return "m4a".to_string();
    }

    if mime.contains("ogg") || asset.display_name.to_ascii_lowercase().ends_with(".ogg") {
        return "ogg".to_string();
    }

    if mime.contains("flac") || asset.display_name.to_ascii_lowercase().ends_with(".flac") {
        return "flac".to_string();
    }

    if mime.contains("webm") || asset.display_name.to_ascii_lowercase().ends_with(".webm") {
        return "webm".to_string();
    }

    "wav".to_string()
}

/// 阿里云回退路径下使用 chat completions 音频输入做转写。
async fn transcribe_audio_online_with_aliyun(
    request: &TranscribeAudioRequest,
) -> Result<String, String> {
    let asset = get_asset(&request.asset_id)?;

    if !matches!(asset.kind, AssetKind::Audio) {
        return Err(format!("附件 {} 不是音频资源。", request.asset_id));
    }

    let file_bytes = std::fs::read(&asset.file_path).map_err(|error| {
        format!(
            "读取音频附件失败，path={}, error={error}",
            asset.file_path.display()
        )
    })?;
    let config = load_aliyun_fallback_config(&read_env_or_default(
        "ALIYUN_AUDIO_MODEL",
        ALIYUN_DASHSCOPE_AUDIO_MODEL,
    ))?;
    let client = Client::builder()
        .build()
        .map_err(|error| format!("创建阿里云音频转写 HTTP 客户端失败：{error}"))?;
    let audio_base64 = STANDARD.encode(file_bytes);
    let audio_format = audio_format_from_asset(&asset);

    let mut prompt = String::from("请将这段音频完整转写为中文文本，尽量保留原意。");

    if let Some(language) = request.language.as_deref() {
        let trimmed = language.trim();
        if !trimmed.is_empty() {
            prompt.push_str("\n语言提示：");
            prompt.push_str(trimmed);
        }
    }

    if let Some(extra_prompt) = request.prompt.as_deref() {
        let trimmed = extra_prompt.trim();
        if !trimmed.is_empty() {
            prompt.push_str("\n补充说明：");
            prompt.push_str(trimmed);
        }
    }

    let response = client
        .post(build_chat_completions_url(&config.base_url))
        .headers(build_request_headers(&config))
        .json(&json!({
            "model": config.model,
            "stream": false,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": prompt
                        },
                        {
                            "type": "input_audio",
                            "input_audio": {
                                "data": audio_base64,
                                "format": audio_format
                            }
                        }
                    ]
                }
            ]
        }))
        .send()
        .await
        .map_err(|error| format!("请求阿里云音频转写失败：{error}"))?;

    if !response.status().is_success() {
        return Err(extract_response_error(response).await);
    }

    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("解析阿里云音频转写响应失败：{error}"))?;

    payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| "阿里云音频转写没有返回可用文本。".to_string())
}

/// 在线模式下执行音频转写。
async fn transcribe_audio_online(request: &TranscribeAudioRequest) -> Result<String, String> {
    if online_uses_aliyun_fallback() {
        return transcribe_audio_online_with_aliyun(request).await;
    }

    let asset = get_asset(&request.asset_id)?;

    if !matches!(asset.kind, AssetKind::Audio) {
        return Err(format!("附件 {} 不是音频资源。", request.asset_id));
    }

    let file_bytes = std::fs::read(&asset.file_path).map_err(|error| {
        format!(
            "读取音频附件失败，path={}, error={error}",
            asset.file_path.display()
        )
    })?;
    let config =
        load_provider_config_with_model_override(AgentMode::Online, Some("OPENAI_AUDIO_MODEL"))?;
    let client = Client::builder()
        .build()
        .map_err(|error| format!("创建音频转写 HTTP 客户端失败：{error}"))?;

    let mut file_part = multipart::Part::bytes(file_bytes).file_name(asset.display_name.clone());
    file_part = file_part
        .mime_str(&asset.mime_type)
        .map_err(|error| format!("设置音频 MIME 类型失败：{error}"))?;

    let mut form = multipart::Form::new()
        .part("file", file_part)
        .text("model", config.model);

    if let Some(language) = request.language.as_deref() {
        let trimmed = language.trim();
        if !trimmed.is_empty() {
            form = form.text("language", trimmed.to_string());
        }
    }

    if let Some(prompt) = request.prompt.as_deref() {
        let trimmed = prompt.trim();
        if !trimmed.is_empty() {
            form = form.text("prompt", trimmed.to_string());
        }
    }

    let response = client
        .post(build_audio_transcriptions_url(&config.base_url))
        .bearer_auth(config.api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|error| format!("请求在线音频转写失败：{error}"))?;

    if !response.status().is_success() {
        return Err(extract_response_error(response).await);
    }

    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("解析在线音频转写响应失败：{error}"))?;

    payload
        .get("text")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| "在线音频转写接口没有返回 text 字段。".to_string())
}

/// 本地模式下执行音频转写。
async fn transcribe_audio_local(request: &TranscribeAudioRequest) -> Result<String, String> {
    let asset = get_asset(&request.asset_id)?;

    if !matches!(asset.kind, AssetKind::Audio) {
        return Err(format!("附件 {} 不是音频资源。", request.asset_id));
    }

    let script_path =
        audio_transcribe_script_path().ok_or_else(|| "无法定位本地音频转写脚本。".to_string())?;
    let model_name = read_env_var("LOCAL_AUDIO_MODEL").unwrap_or_else(|| "base".to_string());

    let mut args = vec![
        "--path".to_string(),
        asset.file_path.display().to_string(),
        "--model".to_string(),
        model_name,
    ];

    if let Some(language) = request.language.as_deref() {
        let trimmed = language.trim();
        if !trimmed.is_empty() {
            args.push("--language".to_string());
            args.push(trimmed.to_string());
        }
    }

    if let Some(prompt) = request.prompt.as_deref() {
        let trimmed = prompt.trim();
        if !trimmed.is_empty() {
            args.push("--prompt".to_string());
            args.push(trimmed.to_string());
        }
    }

    let raw_output = run_python_script(&script_path, &args).await?;
    let payload: Value = serde_json::from_str(&raw_output)
        .map_err(|error| format!("解析本地音频转写结果失败：{error}"))?;

    payload
        .get("text")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| "本地音频转写脚本没有返回 text 字段。".to_string())
}

/// 对外统一的音频转写入口。
pub(crate) async fn transcribe_audio(request: TranscribeAudioRequest) -> Result<String, String> {
    match request.mode {
        AgentMode::Online => transcribe_audio_online(&request).await,
        AgentMode::Local => transcribe_audio_local(&request).await,
    }
}
