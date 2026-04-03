// Tauri 后端核心文件。
// 这个阶段开始，后端除了执行终端命令，还负责：
// 1. 从后端环境变量读取在线/本地模型配置
// 2. 以 OpenAI-compatible Chat Completions 协议请求模型
// 3. 在后端完成 tool calling 循环
// 4. 通过 Tauri 事件把流式输出实时推送给前端
use std::{
    collections::BTreeMap,
    env,
    process::Command,
    sync::Once,
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(target_os = "windows")]
use base64::{engine::general_purpose::STANDARD, Engine as _};
#[cfg(target_os = "windows")]
use encoding_rs::GBK;
use futures_util::StreamExt;
use reqwest::{header, Client, Response};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

const MAX_TOOL_CALL_ROUNDS: usize = 10;
const STREAM_EVENT_NAME: &str = "agent-stream";
const TOOL_NAME: &str = "execute_terminal_command";
const ALIYUN_DASHSCOPE_BASE_URL: &str = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const ALIYUN_DASHSCOPE_MODEL: &str = "qwen3-max";
const SYSTEM_PROMPT: &str = "你是 AI-Universal-Assistant，运行在桌面端系统助手中。
你可以在有必要时调用 execute_terminal_command 工具，在用户当前操作系统的终端中执行命令。
只有在确实需要查看系统信息、验证环境、执行终端指令或读取命令输出时才调用工具。
不要编造未执行过的命令结果。
收到工具输出后，请结合真实结果继续分析，直到给出清晰的最终回复。
除非用户明确要求，否则不要执行明显具有破坏性的命令。";

static ENV_LOADED: Once = Once::new();

fn timestamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn log_info(message: impl AsRef<str>) {
    println!("[agent][{}] {}", timestamp_ms(), message.as_ref());
}

fn log_error(message: impl AsRef<str>) {
    eprintln!("[agent][{}][error] {}", timestamp_ms(), message.as_ref());
}

fn preview_text(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    let mut preview = trimmed.chars().take(max_chars).collect::<String>();

    if trimmed.chars().count() > max_chars {
        preview.push_str("...");
    }

    if preview.is_empty() {
        "(empty)".to_string()
    } else {
        preview
    }
}

fn redact_secret(secret: &str) -> String {
    if secret.is_empty() {
        return "(empty)".to_string();
    }

    let char_count = secret.chars().count();

    if char_count <= 8 {
        return "***".to_string();
    }

    let prefix = secret.chars().take(4).collect::<String>();
    let suffix = secret
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<String>();

    format!("{prefix}***{suffix}")
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum AgentMode {
    Online,
    Local,
}

impl AgentMode {
    fn label(self) -> &'static str {
        match self {
            Self::Online => "在线模式",
            Self::Local => "本地模式",
        }
    }

    fn env_names(self) -> ProviderEnvNames {
        match self {
            Self::Online => ProviderEnvNames {
                base_url: "OPENAI_BASE_URL",
                model: "OPENAI_MODEL",
                api_key: Some("OPENAI_API_KEY"),
            },
            Self::Local => ProviderEnvNames {
                base_url: "OLLAMA_BASE_URL",
                model: "OLLAMA_MODEL",
                api_key: Some("OLLAMA_API_KEY"),
            },
        }
    }

    fn api_key_required(self) -> bool {
        matches!(self, Self::Online)
    }
}

fn read_online_api_key() -> Option<String> {
    // 在线模式优先支持单独填写阿里云 Key；
    // 如果未设置，则回退使用 OPENAI_API_KEY，兼容已有配置习惯。
    read_env_var("ALIYUN_API_KEY").or_else(|| read_env_var("OPENAI_API_KEY"))
}

#[derive(Debug, Clone, Copy)]
struct ProviderEnvNames {
    base_url: &'static str,
    model: &'static str,
    api_key: Option<&'static str>,
}

#[derive(Debug, Clone)]
struct ProviderConfig {
    base_url: String,
    model: String,
    api_key: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendModeStatus {
    mode: AgentMode,
    configured: bool,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendModeStatuses {
    online: BackendModeStatus,
    local: BackendModeStatus,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentTurnRequest {
    mode: AgentMode,
    stream_id: String,
    messages: Vec<ConversationMessageDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentTurnResult {
    new_messages: Vec<ConversationMessageDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversationMessageDto {
    role: String,
    content: Option<String>,
    #[serde(default)]
    tool_call_id: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<ToolCallDto>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolCallDto {
    id: String,
    #[serde(rename = "type")]
    tool_type: String,
    function: ToolFunctionDto,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolFunctionDto {
    name: String,
    arguments: String,
}

#[derive(Debug, Default)]
struct StreamCompletionResult {
    content: String,
    tool_calls: Vec<ToolCallDto>,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionChunk {
    choices: Vec<ChatCompletionChoiceChunk>,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionChoiceChunk {
    delta: ChatCompletionDelta,
}

#[derive(Debug, Default, Deserialize)]
struct ChatCompletionDelta {
    content: Option<String>,
    tool_calls: Option<Vec<ToolCallChunk>>,
}

#[derive(Debug, Deserialize)]
struct ToolCallChunk {
    index: Option<usize>,
    id: Option<String>,
    #[serde(rename = "type")]
    tool_type: Option<String>,
    function: Option<ToolFunctionChunk>,
}

#[derive(Debug, Default, Deserialize)]
struct ToolFunctionChunk {
    name: Option<String>,
    arguments: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase")]
enum AgentStreamEvent {
    Status { stream_id: String, message: String },
    AssistantStart { stream_id: String },
    AssistantDelta { stream_id: String, delta: String },
    AssistantComplete {
        stream_id: String,
        content: String,
        has_tool_calls: bool,
    },
    ToolCall {
        stream_id: String,
        tool_name: String,
        command: String,
    },
    ToolResult {
        stream_id: String,
        output: String,
        success: bool,
    },
}

#[derive(Debug, Deserialize)]
struct ToolArguments {
    command: String,
}

#[cfg(target_os = "windows")]
fn encode_powershell_command(command: &str) -> String {
    let script = format!(
        "$utf8NoBom = [System.Text.UTF8Encoding]::new($false); \
         [Console]::InputEncoding = $utf8NoBom; \
         [Console]::OutputEncoding = $utf8NoBom; \
         $OutputEncoding = $utf8NoBom; \
         {command}"
    );

    let utf16_bytes = script
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect::<Vec<_>>();

    STANDARD.encode(utf16_bytes)
}

fn decode_command_output(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }

    if bytes.starts_with(&[0xFF, 0xFE]) {
        let utf16 = bytes[2..]
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();

        return String::from_utf16_lossy(&utf16);
    }

    if bytes.starts_with(&[0xFE, 0xFF]) {
        let utf16 = bytes[2..]
            .chunks_exact(2)
            .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();

        return String::from_utf16_lossy(&utf16);
    }

    if let Ok(utf8) = String::from_utf8(bytes.to_vec()) {
        return utf8;
    }

    #[cfg(target_os = "windows")]
    {
        let (decoded, _, _) = GBK.decode(bytes);
        return decoded.into_owned();
    }

    #[cfg(not(target_os = "windows"))]
    {
        String::from_utf8_lossy(bytes).to_string()
    }
}

fn load_backend_env_once() {
    ENV_LOADED.call_once(|| {
        match dotenvy::dotenv() {
            Ok(path) => log_info(format!("已加载 .env 文件：{}", path.display())),
            Err(error) => log_info(format!("未加载到 .env 文件，将继续使用系统环境变量：{error}")),
        }
    });
}

fn read_env_var(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn provider_status(mode: AgentMode) -> BackendModeStatus {
    load_backend_env_once();
    log_info(format!("检查后端模式配置状态：{}", mode.label()));

    if matches!(mode, AgentMode::Online) && read_env_var("OPENAI_BASE_URL").is_none() {
        return if read_online_api_key().is_some() {
            log_info("在线模式未设置 OPENAI_BASE_URL，将回退到阿里云 DashScope。");
            BackendModeStatus {
                mode,
                configured: true,
                message: format!(
                    "{}未提供 OPENAI_BASE_URL，已自动回退到阿里云 DashScope（{}，模型 {}）。",
                    mode.label(),
                    ALIYUN_DASHSCOPE_BASE_URL,
                    ALIYUN_DASHSCOPE_MODEL
                ),
            }
        } else {
            log_error("在线模式未设置 OPENAI_BASE_URL，且未找到 ALIYUN_API_KEY / OPENAI_API_KEY。");
            BackendModeStatus {
                mode,
                configured: false,
                message: "在线模式未提供 OPENAI_BASE_URL，将回退到阿里云 DashScope，但缺少 API Key：ALIYUN_API_KEY 或 OPENAI_API_KEY。".to_string(),
            }
        };
    }

    let env_names = mode.env_names();
    let mut missing = Vec::new();

    if read_env_var(env_names.base_url).is_none() {
        missing.push(env_names.base_url);
    }

    if read_env_var(env_names.model).is_none() {
        missing.push(env_names.model);
    }

    if mode.api_key_required() {
        if let Some(api_key_name) = env_names.api_key {
            if read_env_var(api_key_name).is_none() {
                missing.push(api_key_name);
            }
        }
    }

    if missing.is_empty() {
        BackendModeStatus {
            mode,
            configured: true,
            message: format!("{}已从后端环境变量加载完成。", mode.label()),
        }
    } else {
        BackendModeStatus {
            mode,
            configured: false,
            message: format!(
                "{}未配置完成，缺少环境变量：{}",
                mode.label(),
                missing.join(", ")
            ),
        }
    }
}

fn load_provider_config(mode: AgentMode) -> Result<ProviderConfig, String> {
    load_backend_env_once();
    log_info(format!("开始加载{}配置。", mode.label()));

    if matches!(mode, AgentMode::Online) && read_env_var("OPENAI_BASE_URL").is_none() {
        let api_key = read_online_api_key().ok_or_else(|| {
            "在线模式未提供 OPENAI_BASE_URL，将回退到阿里云 DashScope，但缺少 API Key：ALIYUN_API_KEY 或 OPENAI_API_KEY。"
                .to_string()
        })?;

        log_info(format!(
            "在线模式使用阿里云 DashScope 回退配置，base_url={}, model={}, api_key={}",
            ALIYUN_DASHSCOPE_BASE_URL,
            ALIYUN_DASHSCOPE_MODEL,
            redact_secret(&api_key)
        ));

        return Ok(ProviderConfig {
            base_url: ALIYUN_DASHSCOPE_BASE_URL.to_string(),
            model: ALIYUN_DASHSCOPE_MODEL.to_string(),
            api_key,
        });
    }

    let env_names = mode.env_names();
    let base_url = read_env_var(env_names.base_url)
        .ok_or_else(|| format!("缺少环境变量 {}", env_names.base_url))?;
    let model =
        read_env_var(env_names.model).ok_or_else(|| format!("缺少环境变量 {}", env_names.model))?;
    let api_key = env_names
        .api_key
        .and_then(read_env_var)
        .unwrap_or_default();

    if mode.api_key_required() && api_key.is_empty() {
        log_error(format!(
            "{}缺少 API Key，期望环境变量 {}。",
            mode.label(),
            env_names.api_key.unwrap_or("API_KEY")
        ));
        return Err(format!(
            "{}缺少 API Key 环境变量 {}",
            mode.label(),
            env_names.api_key.unwrap_or("API_KEY")
        ));
    }

    log_info(format!(
        "{}配置已加载：base_url={}, model={}, api_key={}",
        mode.label(),
        base_url,
        model,
        redact_secret(&api_key)
    ));

    Ok(ProviderConfig {
        base_url,
        model,
        api_key,
    })
}

fn build_chat_completions_url(base_url: &str) -> String {
    if base_url.ends_with("/chat/completions") {
        base_url.to_string()
    } else {
        format!("{}/chat/completions", base_url.trim_end_matches('/'))
    }
}

fn openai_tools_payload() -> Value {
    json!([
      {
        "type": "function",
        "function": {
          "name": TOOL_NAME,
          "description": "在用户的操作系统终端执行自定义指令",
          "parameters": {
            "type": "object",
            "properties": {
              "command": {
                "type": "string",
                "description": "需要在用户本地终端执行的完整命令字符串"
              }
            },
            "required": ["command"],
            "additionalProperties": false
          }
        }
      }
    ])
}

fn emit_stream_event(app: &AppHandle, event: AgentStreamEvent) -> Result<(), String> {
    app.emit(STREAM_EVENT_NAME, event)
        .map_err(|error| format!("发送流式事件失败：{error}"))
}

fn build_request_headers(config: &ProviderConfig) -> header::HeaderMap {
    let mut headers = header::HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/json"),
    );
    headers.insert(
        header::ACCEPT,
        header::HeaderValue::from_static("text/event-stream"),
    );

    if !config.api_key.is_empty() {
        let value = format!("Bearer {}", config.api_key);
        if let Ok(header_value) = header::HeaderValue::from_str(&value) {
            headers.insert(header::AUTHORIZATION, header_value);
        }
    }

    headers
}

fn frontend_message_to_openai_value(message: &ConversationMessageDto) -> Result<Value, String> {
    match message.role.as_str() {
        "user" => Ok(json!({
            "role": "user",
            "content": message.content.clone().unwrap_or_default(),
        })),
        "assistant" => {
            let mut value = json!({
                "role": "assistant",
                "content": message.content,
            });

            if let Some(tool_calls) = &message.tool_calls {
                value["tool_calls"] = serde_json::to_value(tool_calls)
                    .map_err(|error| format!("序列化 assistant tool_calls 失败：{error}"))?;
            }

            Ok(value)
        }
        "tool" => Ok(json!({
            "role": "tool",
            "content": message.content.clone().unwrap_or_default(),
            "tool_call_id": message.tool_call_id.clone().unwrap_or_default(),
        })),
        other => Err(format!("不支持的消息角色：{other}")),
    }
}

fn build_openai_messages(messages: &[ConversationMessageDto]) -> Result<Vec<Value>, String> {
    let mut request_messages = vec![json!({
        "role": "system",
        "content": SYSTEM_PROMPT,
    })];

    for message in messages {
        request_messages.push(frontend_message_to_openai_value(message)?);
    }

    Ok(request_messages)
}

async fn extract_response_error(response: Response) -> String {
    let status = response.status();
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let text = match response.text().await {
        Ok(text) => text,
        Err(_) => String::new(),
    };

    if content_type.contains("application/json") {
        if let Ok(payload) = serde_json::from_str::<Value>(&text) {
            if let Some(message) = payload
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
            {
                return message.to_string();
            }

            if let Some(message) = payload.get("message").and_then(Value::as_str) {
                return message.to_string();
            }
        }
    }

    if !text.trim().is_empty() {
        log_error(format!(
            "模型接口返回错误，status={}, body_preview={}",
            status,
            preview_text(&text, 300)
        ));
        text
    } else {
        log_error(format!("模型接口返回错误，status={}，且响应体为空。", status));
        format!("模型请求失败，状态码：{status}")
    }
}

fn find_sse_event_boundary(buffer: &[u8]) -> Option<(usize, usize)> {
    if buffer.len() < 2 {
        return None;
    }

    let mut index = 0;

    while index + 1 < buffer.len() {
        if buffer[index] == b'\n' && buffer[index + 1] == b'\n' {
            return Some((index, 2));
        }

        if index + 3 < buffer.len() && &buffer[index..index + 4] == b"\r\n\r\n" {
            return Some((index, 4));
        }

        index += 1;
    }

    None
}

fn parse_sse_event_data(raw_event: &str) -> String {
    raw_event
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(str::trim)
        .collect::<Vec<_>>()
        .join("\n")
}

fn merge_tool_call_chunk(tool_calls_by_index: &mut BTreeMap<usize, ToolCallDto>, chunk: ToolCallChunk) {
    let index = chunk.index.unwrap_or(0);
    let current = tool_calls_by_index.entry(index).or_insert_with(|| ToolCallDto {
        id: chunk.id.clone().unwrap_or_else(|| format!("tool-{index}")),
        tool_type: chunk
            .tool_type
            .clone()
            .unwrap_or_else(|| "function".to_string()),
        function: ToolFunctionDto {
            name: String::new(),
            arguments: String::new(),
        },
    });

    if let Some(id) = chunk.id {
        current.id = id;
    }

    if let Some(tool_type) = chunk.tool_type {
        current.tool_type = tool_type;
    }

    if let Some(function) = chunk.function {
        if let Some(name) = function.name {
            current.function.name.push_str(&name);
        }

        if let Some(arguments) = function.arguments {
            current.function.arguments.push_str(&arguments);
        }
    }
}

async fn stream_chat_completion(
    app: &AppHandle,
    client: &Client,
    config: &ProviderConfig,
    stream_id: &str,
    messages: &[ConversationMessageDto],
) -> Result<StreamCompletionResult, String> {
    log_info(format!(
        "开始请求模型，stream_id={}, url={}, model={}, messages={}",
        stream_id,
        build_chat_completions_url(&config.base_url),
        config.model,
        messages.len()
    ));
    emit_stream_event(
        app,
        AgentStreamEvent::Status {
            stream_id: stream_id.to_string(),
            message: "正在请求模型...".to_string(),
        },
    )?;
    emit_stream_event(
        app,
        AgentStreamEvent::AssistantStart {
            stream_id: stream_id.to_string(),
        },
    )?;

    let response = client
        .post(build_chat_completions_url(&config.base_url))
        .headers(build_request_headers(config))
        .json(&json!({
            "model": config.model,
            "stream": true,
            "tool_choice": "auto",
            "messages": build_openai_messages(messages)?,
            "tools": openai_tools_payload(),
        }))
        .send()
        .await
        .map_err(|error| format!("请求模型失败：{error}"))?;

    log_info(format!(
        "模型接口已响应，stream_id={}, status={}",
        stream_id,
        response.status()
    ));

    if !response.status().is_success() {
        return Err(extract_response_error(response).await);
    }

    let mut buffer = Vec::<u8>::new();
    let mut content = String::new();
    let mut tool_calls_by_index = BTreeMap::<usize, ToolCallDto>::new();
    let mut stream = response.bytes_stream();
    let mut stream_done = false;

    while let Some(item) = stream.next().await {
        let chunk = item.map_err(|error| format!("读取流式响应失败：{error}"))?;
        buffer.extend_from_slice(&chunk);

        while let Some((boundary_index, boundary_len)) = find_sse_event_boundary(&buffer) {
            let event_bytes = buffer[..boundary_index].to_vec();
            buffer.drain(..boundary_index + boundary_len);

            let raw_event = String::from_utf8_lossy(&event_bytes).to_string();
            let event_data = parse_sse_event_data(&raw_event);

            if event_data.is_empty() {
                continue;
            }

            if event_data == "[DONE]" {
                stream_done = true;
                break;
            }

            let chunk: ChatCompletionChunk = serde_json::from_str(&event_data)
                .map_err(|error| format!("解析模型流式数据失败：{error}\n原始数据：{event_data}"))?;

            if let Some(choice) = chunk.choices.into_iter().next() {
                if let Some(delta) = choice.delta.content {
                    content.push_str(&delta);
                    log_info(format!(
                        "收到模型文本增量，stream_id={}, delta_preview={}",
                        stream_id,
                        preview_text(&delta, 120)
                    ));
                    emit_stream_event(
                        app,
                        AgentStreamEvent::AssistantDelta {
                            stream_id: stream_id.to_string(),
                            delta,
                        },
                    )?;
                }

                if let Some(tool_calls) = choice.delta.tool_calls {
                    for tool_call in tool_calls {
                        merge_tool_call_chunk(&mut tool_calls_by_index, tool_call);
                    }
                    log_info(format!(
                        "收到模型 tool_calls 增量，stream_id={}, current_tool_calls={}",
                        stream_id,
                        tool_calls_by_index.len()
                    ));
                }
            }
        }

        if stream_done {
            break;
        }
    }

    emit_stream_event(
        app,
        AgentStreamEvent::AssistantComplete {
            stream_id: stream_id.to_string(),
            content: content.clone(),
            has_tool_calls: !tool_calls_by_index.is_empty(),
        },
    )?;

    log_info(format!(
        "模型流式完成，stream_id={}, content_preview={}, tool_calls={}",
        stream_id,
        preview_text(&content, 160),
        tool_calls_by_index.len()
    ));

    Ok(StreamCompletionResult {
        content,
        tool_calls: tool_calls_by_index.into_values().collect(),
    })
}

fn build_tool_error_result(error: &str) -> String {
    format!("命令执行失败：\n{error}")
}

fn parse_tool_command(arguments_text: &str) -> Result<String, String> {
    let parsed: ToolArguments = serde_json::from_str(arguments_text)
        .map_err(|error| format!("模型返回的工具参数不是合法 JSON：{error}"))?;
    let command = parsed.command.trim().to_string();

    if command.is_empty() {
        return Err("工具参数中的 command 不能为空。".to_string());
    }

    Ok(command)
}

async fn execute_tool_call(
    app: &AppHandle,
    stream_id: &str,
    tool_call: &ToolCallDto,
) -> Result<ConversationMessageDto, String> {
    if tool_call.function.name != TOOL_NAME {
        return Err(format!("模型请求了未支持的工具：{}", tool_call.function.name));
    }

    let command = parse_tool_command(&tool_call.function.arguments)?;
    log_info(format!(
        "准备执行工具调用，stream_id={}, tool={}, command={}",
        stream_id,
        tool_call.function.name,
        command
    ));

    emit_stream_event(
        app,
        AgentStreamEvent::Status {
            stream_id: stream_id.to_string(),
            message: format!("正在执行终端命令：{command}"),
        },
    )?;
    emit_stream_event(
        app,
        AgentStreamEvent::ToolCall {
            stream_id: stream_id.to_string(),
            tool_name: tool_call.function.name.clone(),
            command: command.clone(),
        },
    )?;

    let tool_output = match run_command(command) {
        Ok(output) if output.trim().is_empty() => "(命令执行成功，但没有输出)".to_string(),
        Ok(output) => output,
        Err(error) => build_tool_error_result(&error),
    };

    let success = !tool_output.starts_with("命令执行失败：");
    log_info(format!(
        "工具调用完成，stream_id={}, success={}, output_preview={}",
        stream_id,
        success,
        preview_text(&tool_output, 200)
    ));

    emit_stream_event(
        app,
        AgentStreamEvent::ToolResult {
            stream_id: stream_id.to_string(),
            output: tool_output.clone(),
            success,
        },
    )?;

    Ok(ConversationMessageDto {
        role: "tool".to_string(),
        content: Some(tool_output),
        tool_call_id: Some(tool_call.id.clone()),
        tool_calls: None,
    })
}

#[tauri::command]
fn get_backend_mode_statuses() -> Result<BackendModeStatuses, String> {
    log_info("前端请求读取后端模式状态。");
    Ok(BackendModeStatuses {
        online: provider_status(AgentMode::Online),
        local: provider_status(AgentMode::Local),
    })
}

#[tauri::command]
async fn run_agent_turn(
    app: AppHandle,
    request: AgentTurnRequest,
) -> Result<AgentTurnResult, String> {
    log_info(format!(
        "开始执行代理轮次，stream_id={}, mode={}, input_messages={}",
        request.stream_id,
        request.mode.label(),
        request.messages.len()
    ));
    let config = load_provider_config(request.mode)?;
    let client = Client::builder()
        .build()
        .map_err(|error| format!("创建 HTTP 客户端失败：{error}"))?;

    let mut conversation = request.messages.clone();
    let mut new_messages = Vec::<ConversationMessageDto>::new();

    for round in 0..MAX_TOOL_CALL_ROUNDS {
        log_info(format!(
            "进入代理循环，stream_id={}, round={}/{}",
            request.stream_id,
            round + 1,
            MAX_TOOL_CALL_ROUNDS
        ));
        let completion = stream_chat_completion(
            &app,
            &client,
            &config,
            &request.stream_id,
            &conversation,
        )
        .await?;

        let assistant_message = ConversationMessageDto {
            role: "assistant".to_string(),
            content: if completion.content.is_empty() {
                None
            } else {
                Some(completion.content.clone())
            },
            tool_call_id: None,
            tool_calls: if completion.tool_calls.is_empty() {
                None
            } else {
                Some(completion.tool_calls.clone())
            },
        };

        conversation.push(assistant_message.clone());
        new_messages.push(assistant_message);

        if completion.tool_calls.is_empty() {
            log_info(format!(
                "本轮模型未请求工具，stream_id={}, assistant_preview={}",
                request.stream_id,
                preview_text(&completion.content, 200)
            ));
            emit_stream_event(
                &app,
                AgentStreamEvent::Status {
                    stream_id: request.stream_id.clone(),
                    message: "本轮对话已完成。".to_string(),
                },
            )?;
            return Ok(AgentTurnResult { new_messages });
        }

        if round == MAX_TOOL_CALL_ROUNDS - 1 {
            log_error(format!(
                "工具调用超过最大轮次限制，stream_id={}, limit={}",
                request.stream_id, MAX_TOOL_CALL_ROUNDS
            ));
            return Err(format!(
                "工具调用超过最大轮次限制（{MAX_TOOL_CALL_ROUNDS}），已自动停止。"
            ));
        }

        for tool_call in &completion.tool_calls {
            let tool_message = execute_tool_call(&app, &request.stream_id, tool_call).await?;
            conversation.push(tool_message.clone());
            new_messages.push(tool_message);
        }

        emit_stream_event(
            &app,
            AgentStreamEvent::Status {
                stream_id: request.stream_id.clone(),
                message: "已将终端结果回传给模型，继续推理...".to_string(),
            },
        )?;
    }

    log_error(format!(
        "代理循环异常结束，stream_id={}, reason=tool round overflow",
        request.stream_id
    ));
    Err(format!(
        "工具调用超过最大轮次限制（{MAX_TOOL_CALL_ROUNDS}），已自动停止。"
    ))
}

#[tauri::command]
fn run_command(command: String) -> Result<String, String> {
    log_info(format!("开始执行终端命令：{}", command));
    let output = if cfg!(target_os = "windows") {
        let encoded_command = encode_powershell_command(&command);

        Command::new("powershell")
            .arg("-NoProfile")
            .arg("-NonInteractive")
            .arg("-EncodedCommand")
            .arg(encoded_command)
            .output()
    } else if cfg!(target_os = "linux") || cfg!(target_os = "macos") {
        Command::new("bash").arg("-c").arg(&command).output()
    } else {
        return Err("Unsupported operating system".to_string());
    }
    .map_err(|error| format!("Failed to execute command: {error}"))?;

    let stdout = decode_command_output(&output.stdout)
        .trim_end_matches(['\r', '\n'])
        .to_string();
    let stderr = decode_command_output(&output.stderr).trim().to_string();

    if output.status.success() {
        log_info(format!(
            "终端命令执行成功，command={}, stdout_preview={}",
            command,
            preview_text(&stdout, 200)
        ));
        Ok(stdout)
    } else if stderr.is_empty() {
        log_error(format!(
            "终端命令执行失败但 stderr 为空，command={}",
            command
        ));
        Err("Command failed without stderr output.".to_string())
    } else {
        log_error(format!(
            "终端命令执行失败，command={}, stderr_preview={}",
            command,
            preview_text(&stderr, 200)
        ));
        Err(stderr)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    load_backend_env_once();
    log_info("Tauri 后端已启动，等待前端调用。");

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_backend_mode_statuses,
            run_agent_turn,
            run_command
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{
        build_chat_completions_url, decode_command_output, parse_tool_command,
        ALIYUN_DASHSCOPE_BASE_URL, ALIYUN_DASHSCOPE_MODEL,
    };

    #[test]
    fn decodes_utf16le_output_with_bom() {
        let bytes = vec![0xFF, 0xFE, 0x2D, 0x4E, 0x87, 0x65, 0x0D, 0x00, 0x0A, 0x00];
        assert_eq!(decode_command_output(&bytes), "中文\r\n");
    }

    #[test]
    fn decodes_utf8_output() {
        assert_eq!(decode_command_output("hello".as_bytes()), "hello");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn decodes_gbk_output() {
        let bytes = vec![0xD6, 0xD0, 0xCE, 0xC4];
        assert_eq!(decode_command_output(&bytes), "中文");
    }

    #[test]
    fn appends_chat_completions_path_when_needed() {
        assert_eq!(
            build_chat_completions_url("http://localhost:11434/v1"),
            "http://localhost:11434/v1/chat/completions"
        );
    }

    #[test]
    fn keeps_full_chat_completions_url() {
        assert_eq!(
            build_chat_completions_url("http://localhost:11434/v1/chat/completions"),
            "http://localhost:11434/v1/chat/completions"
        );
    }

    #[test]
    fn parses_tool_command_arguments() {
        assert_eq!(
            parse_tool_command(r#"{"command":"echo hello"}"#).unwrap(),
            "echo hello"
        );
    }

    #[test]
    fn aliyun_dashscope_fallback_constants_are_expected() {
        assert_eq!(
            ALIYUN_DASHSCOPE_BASE_URL,
            "https://dashscope.aliyuncs.com/compatible-mode/v1"
        );
        assert_eq!(ALIYUN_DASHSCOPE_MODEL, "qwen3-max");
    }
}
