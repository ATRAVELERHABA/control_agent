//! 实现图像分析工具，支持在线模式和本地模式的统一调用。

use base64::{engine::general_purpose::STANDARD, Engine as _};
use reqwest::Client;
use serde_json::{json, Value};

use crate::{
    assets::get_asset,
    constants::ALIYUN_DASHSCOPE_VISION_MODEL,
    env::{
        load_aliyun_fallback_config, load_provider_config_with_model_override,
        online_uses_aliyun_fallback, read_env_or_default,
    },
    llm::{build_chat_completions_url, build_request_headers, extract_response_error},
    models::{AgentMode, AnalyzeImageRequest, AssetKind},
};

/// 从模型返回的消息内容中提取文本。
fn extract_message_text(payload: &Value) -> Option<String> {
    let content = payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))?;

    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }

    if let Some(parts) = content.as_array() {
        let text = parts
            .iter()
            .filter_map(|part| {
                part.get("text")
                    .and_then(Value::as_str)
                    .or_else(|| part.get("content").and_then(Value::as_str))
            })
            .collect::<Vec<_>>()
            .join("\n");

        if !text.trim().is_empty() {
            return Some(text);
        }
    }

    None
}

/// 构建图像分析任务提示词。
fn analysis_prompt(task: Option<&str>, ocr: bool, display_name: &str) -> String {
    let mut prompt = String::from(
        "请分析这张图片，并用中文输出结构化结果。至少包括：\
        1. 图片主体与场景；\
        2. 关键细节；\
        3. 如果是界面截图，说明布局、主要控件和交互目的；\
        4. 如果存在文字，提取可见文字并标注大致位置；\
        5. 如果不确定，请明确说明不确定。",
    );

    prompt.push_str(&format!("\n图片文件名：{display_name}"));

    if ocr {
        prompt.push_str("\n本次任务要求强化 OCR，请尽量完整提取所有可见文字。");
    }

    if let Some(task) = task {
        let trimmed = task.trim();
        if !trimmed.is_empty() {
            prompt.push_str("\n附加任务要求：");
            prompt.push_str(trimmed);
        }
    }

    prompt
}

/// 执行图像识别。
pub(crate) async fn analyze_image(request: AnalyzeImageRequest) -> Result<String, String> {
    let asset = get_asset(&request.asset_id)?;

    if !matches!(asset.kind, AssetKind::Image) {
        return Err(format!("附件 {} 不是图像资源。", request.asset_id));
    }

    let image_bytes = std::fs::read(&asset.file_path).map_err(|error| {
        format!(
            "读取图像附件失败，path={}, error={error}",
            asset.file_path.display()
        )
    })?;
    let image_base64 = STANDARD.encode(image_bytes);
    let image_url = format!("data:{};base64,{}", asset.mime_type, image_base64);

    let config = match request.mode {
        AgentMode::Online if online_uses_aliyun_fallback() => {
            let model = read_env_or_default("ALIYUN_VISION_MODEL", ALIYUN_DASHSCOPE_VISION_MODEL);
            load_aliyun_fallback_config(&model)?
        }
        AgentMode::Online => load_provider_config_with_model_override(
            AgentMode::Online,
            Some("OPENAI_VISION_MODEL"),
        )?,
        AgentMode::Local => {
            load_provider_config_with_model_override(AgentMode::Local, Some("OLLAMA_VISION_MODEL"))?
        }
    };
    let client = Client::builder()
        .build()
        .map_err(|error| format!("创建图像识别 HTTP 客户端失败：{error}"))?;

    let prompt = analysis_prompt(
        request.task.as_deref(),
        request.ocr.unwrap_or(false),
        &asset.display_name,
    );
    let response = client
        .post(build_chat_completions_url(&config.base_url))
        .headers(build_request_headers(&config))
        .json(&json!({
            "model": config.model,
            "stream": false,
            "messages": [
                {
                    "role": "system",
                    "content": "你是图像识别工具。请忠于图片内容，不要臆测。"
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": prompt
                        },
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": image_url
                            }
                        }
                    ]
                }
            ]
        }))
        .send()
        .await
        .map_err(|error| format!("请求图像识别模型失败：{error}"))?;

    if !response.status().is_success() {
        return Err(extract_response_error(response).await);
    }

    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("解析图像识别响应失败：{error}"))?;

    extract_message_text(&payload)
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| "图像识别模型没有返回可用文本。".to_string())
}
