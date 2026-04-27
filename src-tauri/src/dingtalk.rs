//! DingTalk Stream Mode relay for remote chat and remote control.

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{LazyLock, Mutex},
    time::Instant,
};

use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::AppHandle;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStderr, ChildStdin, ChildStdout},
    sync::Mutex as AsyncMutex,
};

use crate::{
    activation::ensure_license_valid,
    auth::{ensure_authenticated, get_current_user, get_session_status},
    command_runner::execute_shell_command,
    constants::{DINGTALK_STREAM_SCRIPT_RELATIVE_PATH, TOOL_NAME},
    env::{load_provider_config, provider_status, read_env_var},
    llm::{parse_tool_command, stream_chat_completion},
    logging::{log_error, log_info, log_warn, preview_text, timestamp_ms},
    models::{
        AgentMode, ConversationMessageDto, DingTalkLogEntry, DingTalkStatus, ReadWebPageRequest,
        RunCommandRequest as ShellCommandRequest, RunDuckDuckGoSearchRequest, SessionStatus,
        ToolCallDto,
    },
    python::start_python_script,
    search::execute_duckduckgo_search,
    skills::{
        load_skill_definitions, project_root_candidates, terminal_command_requires_confirmation,
    },
    system_time::get_current_system_time,
    webpage::read_webpage,
};

const MAX_EVENT_LOGS: usize = 80;
const MAX_REMOTE_TOOL_ROUNDS: usize = 4;
const MAX_SESSION_MESSAGES: usize = 24;
const MAX_REPLY_CHARS: usize = 3200;

const DINGTALK_CLIENT_ID_ENV: &str = "DINGTALK_CLIENT_ID";
const DINGTALK_CLIENT_SECRET_ENV: &str = "DINGTALK_CLIENT_SECRET";
const DINGTALK_AGENT_MODE_ENV: &str = "DINGTALK_AGENT_MODE";
const DINGTALK_ALLOWED_SENDERS_ENV: &str = "DINGTALK_ALLOWED_SENDERS";
const DINGTALK_ALLOWED_CHATS_ENV: &str = "DINGTALK_ALLOWED_CHATS";
const DINGTALK_ENABLE_REMOTE_COMMANDS_ENV: &str = "DINGTALK_ENABLE_REMOTE_COMMANDS";
const DINGTALK_ALLOWED_COMMAND_PREFIXES_ENV: &str = "DINGTALK_ALLOWED_COMMAND_PREFIXES";
const DINGTALK_ENABLE_REMOTE_SEARCH_ENV: &str = "DINGTALK_ENABLE_REMOTE_SEARCH";
const DINGTALK_SEND_PROCESSING_REPLY_ENV: &str = "DINGTALK_SEND_PROCESSING_REPLY";
const DINGTALK_PROCESSING_REPLY_TEXT_ENV: &str = "DINGTALK_PROCESSING_REPLY_TEXT";

#[derive(Clone)]
struct DingTalkRuntime {
    child: std::sync::Arc<AsyncMutex<Child>>,
    stdin: std::sync::Arc<AsyncMutex<ChildStdin>>,
}

#[derive(Default)]
struct DingTalkState {
    running: bool,
    mode_override: Option<AgentMode>,
    message: String,
    events: Vec<DingTalkLogEntry>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IncomingDingTalkMessage {
    request_id: String,
    text: String,
    sender_id: String,
    #[serde(default)]
    sender_staff_id: Option<String>,
    #[serde(default)]
    sender_nick: Option<String>,
    #[serde(default)]
    conversation_id: Option<String>,
    #[serde(default)]
    chat_id: Option<String>,
    is_group: bool,
}

#[derive(Debug, Deserialize)]
struct DuckDuckGoToolArguments {
    query: String,
    #[serde(default)]
    max_results: Option<u8>,
}

#[derive(Debug, Deserialize)]
struct ReadWebPageToolArguments {
    url: String,
    #[serde(default)]
    max_chars: Option<u32>,
}

static DINGTALK_RUNTIME: LazyLock<Mutex<Option<DingTalkRuntime>>> =
    LazyLock::new(|| Mutex::new(None));
static DINGTALK_STATE: LazyLock<Mutex<DingTalkState>> = LazyLock::new(|| {
    Mutex::new(DingTalkState {
        running: false,
        mode_override: None,
        message: "DingTalk relay is stopped.".to_string(),
        events: Vec::new(),
    })
});
static DINGTALK_CONVERSATIONS: LazyLock<Mutex<HashMap<String, Vec<ConversationMessageDto>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn parse_bool_env(name: &str) -> bool {
    parse_bool_env_with_default(name, false)
}

fn parse_bool_env_with_default(name: &str, default: bool) -> bool {
    read_env_var(name)
        .map(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(default)
}

fn parse_agent_mode(value: &str) -> Option<AgentMode> {
    match value.trim().to_ascii_lowercase().as_str() {
        "online" => Some(AgentMode::Online),
        "local" => Some(AgentMode::Local),
        _ => None,
    }
}

fn configured_mode() -> AgentMode {
    if let Ok(state) = DINGTALK_STATE.lock() {
        if let Some(mode) = state.mode_override {
            return mode;
        }
    }

    read_env_var(DINGTALK_AGENT_MODE_ENV)
        .as_deref()
        .and_then(parse_agent_mode)
        .unwrap_or(AgentMode::Online)
}

fn split_csv_env(name: &str) -> Vec<String> {
    read_env_var(name)
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|part| !part.is_empty())
                .map(|part| part.to_ascii_lowercase())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn split_csv_env_set(name: &str) -> HashSet<String> {
    split_csv_env(name).into_iter().collect()
}

fn remote_command_prefixes() -> Vec<String> {
    split_csv_env(DINGTALK_ALLOWED_COMMAND_PREFIXES_ENV)
}

fn remote_search_enabled() -> bool {
    parse_bool_env(DINGTALK_ENABLE_REMOTE_SEARCH_ENV)
}

fn processing_reply_enabled() -> bool {
    parse_bool_env_with_default(DINGTALK_SEND_PROCESSING_REPLY_ENV, true)
}

fn processing_reply_text() -> String {
    read_env_var(DINGTALK_PROCESSING_REPLY_TEXT_ENV)
        .unwrap_or_else(|| "已收到，正在处理，请稍候。".to_string())
}

fn terminal_command_requires_manual_approval() -> bool {
    terminal_command_requires_confirmation()
}

fn remote_terminal_blocked_message() -> String {
    "除非您选择不经过审核直接运行终端命令，否则我无法运行当前指令。".to_string()
}

fn dingtalk_configured() -> bool {
    read_env_var(DINGTALK_CLIENT_ID_ENV).is_some()
        && read_env_var(DINGTALK_CLIENT_SECRET_ENV).is_some()
}

fn dingtalk_script_path() -> Option<PathBuf> {
    project_root_candidates()
        .into_iter()
        .map(|root| root.join(DINGTALK_STREAM_SCRIPT_RELATIVE_PATH))
        .find(|candidate| candidate.exists())
}

fn trim_reply(text: &str) -> String {
    let normalized = text.trim();
    let mut output = normalized.chars().take(MAX_REPLY_CHARS).collect::<String>();

    if normalized.chars().count() > MAX_REPLY_CHARS {
        output.push_str("\n\n[truncated]");
    }

    if output.is_empty() {
        "(empty reply)".to_string()
    } else {
        output
    }
}

fn push_event(level: &str, message: impl Into<String>) {
    let message = message.into();

    match level {
        "error" => log_error(format!("[dingtalk] {message}")),
        "warn" => log_warn(format!("[dingtalk] {message}")),
        _ => log_info(format!("[dingtalk] {message}")),
    }

    if let Ok(mut state) = DINGTALK_STATE.lock() {
        state.message = message.clone();
        state.events.push(DingTalkLogEntry {
            timestamp: timestamp_ms().to_string(),
            level: level.to_string(),
            message,
        });

        if state.events.len() > MAX_EVENT_LOGS {
            let overflow = state.events.len() - MAX_EVENT_LOGS;
            state.events.drain(0..overflow);
        }
    }
}

fn set_running(running: bool, message: impl Into<String>) {
    let message = message.into();

    if let Ok(mut state) = DINGTALK_STATE.lock() {
        state.running = running;
        state.message = message.clone();
    }

    push_event(if running { "info" } else { "warn" }, message);
}

fn clear_remote_sessions() {
    if let Ok(mut sessions) = DINGTALK_CONVERSATIONS.lock() {
        sessions.clear();
    }
}

fn status_snapshot() -> DingTalkStatus {
    let allowed_senders = split_csv_env(DINGTALK_ALLOWED_SENDERS_ENV);
    let allowed_chats = split_csv_env(DINGTALK_ALLOWED_CHATS_ENV);
    let state = DINGTALK_STATE.lock();

    if let Ok(state) = state {
        let mode = state.mode_override.unwrap_or_else(|| {
            read_env_var(DINGTALK_AGENT_MODE_ENV)
                .as_deref()
                .and_then(parse_agent_mode)
                .unwrap_or(AgentMode::Online)
        });

        DingTalkStatus {
            configured: dingtalk_configured() && dingtalk_script_path().is_some(),
            running: state.running,
            mode,
            message: state.message.clone(),
            remote_commands_enabled: parse_bool_env(DINGTALK_ENABLE_REMOTE_COMMANDS_ENV),
            allowed_sender_count: allowed_senders.len(),
            allowed_chat_count: allowed_chats.len(),
            events: state.events.clone(),
        }
    } else {
        DingTalkStatus {
            configured: dingtalk_configured() && dingtalk_script_path().is_some(),
            running: false,
            mode: configured_mode(),
            message: "DingTalk 状态暂时不可用。".to_string(),
            remote_commands_enabled: parse_bool_env(DINGTALK_ENABLE_REMOTE_COMMANDS_ENV),
            allowed_sender_count: allowed_senders.len(),
            allowed_chat_count: allowed_chats.len(),
            events: Vec::new(),
        }
    }
}

fn build_session_key(message: &IncomingDingTalkMessage) -> String {
    let conversation = message
        .conversation_id
        .clone()
        .or_else(|| message.chat_id.clone())
        .unwrap_or_else(|| message.sender_id.clone());

    if message.is_group {
        format!("group::{conversation}::{}", message.sender_id)
    } else {
        format!("dm::{conversation}")
    }
}

fn normalize_incoming_text(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let mut parts = trimmed.split_whitespace().peekable();
    let mut normalized = Vec::new();
    let mut dropping_mentions = true;

    while let Some(part) = parts.next() {
        if dropping_mentions && part.starts_with('@') {
            continue;
        }

        dropping_mentions = false;
        normalized.push(part);
    }

    if normalized.is_empty() {
        trimmed.to_string()
    } else {
        normalized.join(" ")
    }
}

fn sender_allowed(message: &IncomingDingTalkMessage) -> bool {
    let allowed = split_csv_env_set(DINGTALK_ALLOWED_SENDERS_ENV);

    if allowed.is_empty() {
        return true;
    }

    let sender_id = message.sender_id.trim().to_ascii_lowercase();
    let sender_staff_id = message
        .sender_staff_id
        .clone()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();

    allowed.contains(&sender_id)
        || (!sender_staff_id.is_empty() && allowed.contains(&sender_staff_id))
}

fn chat_allowed(message: &IncomingDingTalkMessage) -> bool {
    let allowed = split_csv_env_set(DINGTALK_ALLOWED_CHATS_ENV);

    if allowed.is_empty() {
        return true;
    }

    message
        .conversation_id
        .clone()
        .into_iter()
        .chain(message.chat_id.clone())
        .map(|value| value.trim().to_ascii_lowercase())
        .any(|value| allowed.contains(&value))
}

fn remote_chat_skills() -> Vec<crate::models::SkillDefinition> {
    let enable_remote_search = remote_search_enabled();

    load_skill_definitions()
        .into_iter()
        .filter(|skill| match skill.skill_type {
            crate::models::SkillType::Prompt => true,
            crate::models::SkillType::Tool => skill
                .tool
                .as_ref()
                .map(|tool| {
                    tool.name == TOOL_NAME
                        || tool.name == "get_current_system_time"
                        || (enable_remote_search
                            && (tool.name == "duckduckgo_search" || tool.name == "read_webpage")
                            && !tool.requires_confirmation)
                })
                .unwrap_or(false),
        })
        .collect()
}

async fn execute_remote_tool(app: &AppHandle, tool_call: &ToolCallDto) -> Result<String, String> {
    match tool_call.function.name.as_str() {
        "duckduckgo_search" => {
            let payload: DuckDuckGoToolArguments =
                serde_json::from_str(&tool_call.function.arguments)
                    .map_err(|error| format!("Invalid duckduckgo_search arguments: {error}"))?;

            let query = payload.query.trim().to_string();
            if query.is_empty() {
                return Err("duckduckgo_search requires a non-empty query.".to_string());
            }

            execute_duckduckgo_search(RunDuckDuckGoSearchRequest {
                query,
                max_results: payload.max_results.unwrap_or(5).clamp(1, 10),
            })
            .await
        }
        "read_webpage" => {
            let payload: ReadWebPageToolArguments =
                serde_json::from_str(&tool_call.function.arguments)
                    .map_err(|error| format!("Invalid read_webpage arguments: {error}"))?;

            let url = payload.url.trim().to_string();
            if url.is_empty() {
                return Err("read_webpage requires a non-empty url.".to_string());
            }

            read_webpage(ReadWebPageRequest {
                url,
                max_chars: payload.max_chars,
            })
            .await
        }
        "get_current_system_time" => Ok(get_current_system_time()),
        TOOL_NAME => {
            if terminal_command_requires_manual_approval() {
                return Ok(remote_terminal_blocked_message());
            }

            let command = parse_tool_command(&tool_call.function.arguments)?;
            let output = execute_shell_command(
                app,
                ShellCommandRequest {
                    command,
                    stream_id: None,
                    command_id: None,
                },
            )
            .await?;

            Ok(if output.trim().is_empty() {
                "(command completed without output)".to_string()
            } else {
                output
            })
        }
        other => Err(format!("Unsupported remote tool call: {other}")),
    }
}

fn trim_session_history(messages: &mut Vec<ConversationMessageDto>) {
    if messages.len() > MAX_SESSION_MESSAGES {
        let overflow = messages.len() - MAX_SESSION_MESSAGES;
        messages.drain(0..overflow);
    }
}

async fn run_remote_chat(
    app: &AppHandle,
    mode: AgentMode,
    messages: Vec<ConversationMessageDto>,
) -> Result<Vec<ConversationMessageDto>, String> {
    let config = load_provider_config(mode)?;
    let client = Client::builder()
        .build()
        .map_err(|error| format!("Failed to create HTTP client: {error}"))?;
    let skills = remote_chat_skills();
    let stream_id = format!("dingtalk-{}", timestamp_ms());
    let mut current_messages = messages;

    push_event(
        "info",
        format!(
            "开始钉钉远程对话，mode={}，messages={}，remote_search_enabled={}",
            mode.label(),
            current_messages.len(),
            remote_search_enabled()
        ),
    );

    for round in 0..MAX_REMOTE_TOOL_ROUNDS {
        let round_started_at = Instant::now();
        push_event(
            "info",
            format!("钉钉远程对话第 {} 轮开始请求模型。", round + 1),
        );

        let completion = stream_chat_completion(
            app,
            &client,
            &config,
            &stream_id,
            &current_messages,
            &skills,
        )
        .await?;

        push_event(
            "info",
            format!(
                "钉钉远程对话第 {} 轮模型返回，elapsed_ms={}，content_chars={}，tool_calls={}",
                round + 1,
                round_started_at.elapsed().as_millis(),
                completion.content.chars().count(),
                completion.tool_calls.len()
            ),
        );

        current_messages.push(ConversationMessageDto {
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
        });

        if completion.tool_calls.is_empty() {
            push_event(
                "info",
                format!("钉钉远程对话第 {} 轮结束，无需额外工具调用。", round + 1),
            );
            return Ok(current_messages);
        }

        if completion
            .tool_calls
            .iter()
            .any(|tool_call| tool_call.function.name == TOOL_NAME)
            && terminal_command_requires_manual_approval()
        {
            let warning = remote_terminal_blocked_message();
            push_event(
                "warn",
                "钉钉远程对话请求执行终端命令，但当前仍需人工审核，已直接拒绝。".to_string(),
            );
            current_messages.push(ConversationMessageDto {
                role: "assistant".to_string(),
                content: Some(warning),
                tool_call_id: None,
                tool_calls: None,
            });
            return Ok(current_messages);
        }

        if round + 1 == MAX_REMOTE_TOOL_ROUNDS {
            return Err(format!(
                "Remote chat exceeded the tool round limit ({MAX_REMOTE_TOOL_ROUNDS})."
            ));
        }

        let tool_names = completion
            .tool_calls
            .iter()
            .map(|tool_call| tool_call.function.name.clone())
            .collect::<Vec<_>>();
        push_event(
            "info",
            format!(
                "钉钉远程对话第 {} 轮触发工具调用：{}",
                round + 1,
                tool_names.join(", ")
            ),
        );

        for tool_call in &completion.tool_calls {
            let tool_started_at = Instant::now();
            let output = execute_remote_tool(app, tool_call).await?;
            push_event(
                "info",
                format!(
                    "钉钉工具调用已完成，tool={}，elapsed_ms={}",
                    tool_call.function.name,
                    tool_started_at.elapsed().as_millis()
                ),
            );
            current_messages.push(ConversationMessageDto {
                role: "tool".to_string(),
                content: Some(output),
                tool_call_id: Some(tool_call.id.clone()),
                tool_calls: None,
            });
        }
    }

    Err("Remote chat did not complete.".to_string())
}

fn should_send_processing_notice(text: &str) -> bool {
    if !processing_reply_enabled() || text.is_empty() {
        return false;
    }

    !(text == "/help" || text == "/status" || text == "/clear" || text.starts_with("/mode "))
}

async fn execute_remote_command(app: &AppHandle, command: &str) -> Result<String, String> {
    ensure_license_valid(app)?;
    ensure_authenticated(app)?;

    if !parse_bool_env(DINGTALK_ENABLE_REMOTE_COMMANDS_ENV) {
        return Err(
            "远程命令执行未开启，请先设置 DINGTALK_ENABLE_REMOTE_COMMANDS=true。".to_string(),
        );
    }

    let command = command.trim();
    if command.is_empty() {
        return Err("Command cannot be empty.".to_string());
    }

    if terminal_command_requires_manual_approval() {
        return Ok(remote_terminal_blocked_message());
    }

    let prefixes = remote_command_prefixes();
    if prefixes.is_empty() {
        return Err(
            "未配置允许的远程命令前缀，请设置 DINGTALK_ALLOWED_COMMAND_PREFIXES。".to_string(),
        );
    }

    if !prefixes.iter().any(|prefix| command.starts_with(prefix)) {
        return Err(format!(
            "命令不在允许范围内。允许的前缀：{}",
            prefixes.join(", ")
        ));
    }

    let output = execute_shell_command(
        app,
        ShellCommandRequest {
            command: command.to_string(),
            stream_id: None,
            command_id: None,
        },
    )
    .await?;

    Ok(if output.trim().is_empty() {
        "(command completed without output)".to_string()
    } else {
        output
    })
}

fn set_mode(mode: AgentMode) {
    if let Ok(mut state) = DINGTALK_STATE.lock() {
        state.mode_override = Some(mode);
        state.message = format!("DingTalk relay mode set to {}.", mode.label());
    }
}

async fn build_status_reply(app: &AppHandle) -> String {
    let snapshot = status_snapshot();
    let provider = provider_status(snapshot.mode);
    let session: SessionStatus = match get_session_status(app) {
        Ok(value) => value,
        Err(error) => SessionStatus {
            authenticated: false,
            message: error,
            email: None,
        },
    };
    let user = get_current_user(app).ok().map(|current| current.email);

    format!(
        "Desktop status\nmode: {}\nrelay: {}\nauthenticated: {}\nuser: {}\nprovider: {}\nremote commands: {}\nremote search: {}\nprocessing notice: {}\nallowed senders: {}\nallowed chats: {}",
        snapshot.mode.label(),
        if snapshot.running { "running" } else { "stopped" },
        if session.authenticated { "yes" } else { "no" },
        user.or(session.email).unwrap_or_else(|| "(none)".to_string()),
        provider.message,
        if snapshot.remote_commands_enabled {
            "enabled"
        } else {
            "disabled"
        },
        if remote_search_enabled() {
            "enabled"
        } else {
            "disabled"
        },
        if processing_reply_enabled() {
            "enabled"
        } else {
            "disabled"
        },
        snapshot.allowed_sender_count,
        snapshot.allowed_chat_count,
    )
}

async fn build_help_reply() -> String {
    let prefixes = remote_command_prefixes();

    format!(
        "命令列表\n/help\n/status\n/mode online|local\n/clear\n/run <command>\n\n说明\n- 普通文本会进入远程对话会话\n- 远程 /run 当前{}\n- 允许的命令前缀：{}",
        if parse_bool_env(DINGTALK_ENABLE_REMOTE_COMMANDS_ENV) {
            "已开启"
        } else {
            "未开启"
        },
        if prefixes.is_empty() {
            "(none configured)".to_string()
        } else {
            prefixes.join(", ")
        }
    )
}

async fn build_reply_for_message(
    app: &AppHandle,
    message: &IncomingDingTalkMessage,
) -> Result<String, String> {
    ensure_license_valid(app)?;
    ensure_authenticated(app)?;

    if !sender_allowed(message) {
        return Ok("Sender is not allowed for this desktop relay.".to_string());
    }

    if !chat_allowed(message) {
        return Ok("This chat is not allowed for this desktop relay.".to_string());
    }

    let text = normalize_incoming_text(&message.text);

    if text.is_empty() {
        return Ok("Empty message received.".to_string());
    }

    if text == "/help" {
        return Ok(build_help_reply().await);
    }

    if text == "/status" {
        return Ok(build_status_reply(app).await);
    }

    if text == "/clear" {
        let session_key = build_session_key(message);
        if let Ok(mut sessions) = DINGTALK_CONVERSATIONS.lock() {
            sessions.remove(&session_key);
        }
        return Ok("Remote session cleared.".to_string());
    }

    if let Some(value) = text.strip_prefix("/mode ") {
        let mode =
            parse_agent_mode(value).ok_or_else(|| "Mode must be online or local.".to_string())?;
        set_mode(mode);
        return Ok(format!("Remote mode switched to {}.", mode.label()));
    }

    if let Some(command) = text.strip_prefix("/run ") {
        return execute_remote_command(app, command).await;
    }

    let session_key = build_session_key(message);
    let mut history = if let Ok(sessions) = DINGTALK_CONVERSATIONS.lock() {
        sessions.get(&session_key).cloned().unwrap_or_default()
    } else {
        Vec::new()
    };

    history.push(ConversationMessageDto {
        role: "user".to_string(),
        content: Some(text.clone()),
        tool_call_id: None,
        tool_calls: None,
    });
    trim_session_history(&mut history);

    let mode = configured_mode();
    let updated_history = run_remote_chat(app, mode, history).await?;
    let reply = updated_history
        .iter()
        .rev()
        .find(|message| message.role == "assistant" && message.content.is_some())
        .and_then(|message| message.content.clone())
        .unwrap_or_else(|| "助手返回了空回复。".to_string());

    if let Ok(mut sessions) = DINGTALK_CONVERSATIONS.lock() {
        let mut persisted = updated_history;
        trim_session_history(&mut persisted);
        sessions.insert(session_key, persisted);
    }

    Ok(reply)
}

async fn send_worker_reply(
    stdin: std::sync::Arc<AsyncMutex<ChildStdin>>,
    request_id: &str,
    text: &str,
) -> Result<(), String> {
    push_event(
        "info",
        format!(
            "正在发送钉钉回复，request_id={}，preview={}",
            request_id,
            preview_text(text, 120)
        ),
    );

    let command = json!({
        "type": "reply_text",
        "requestId": request_id,
        "text": trim_reply(text),
    });
    let serialized = serde_json::to_string(&command)
        .map_err(|error| format!("Failed to serialize DingTalk worker command: {error}"))?;

    let mut writer = stdin.lock().await;
    writer
        .write_all(format!("{serialized}\n").as_bytes())
        .await
        .map_err(|error| format!("Failed to write to DingTalk worker stdin: {error}"))?;
    writer
        .flush()
        .await
        .map_err(|error| format!("Failed to flush DingTalk worker stdin: {error}"))?;

    Ok(())
}

async fn send_worker_notice(
    stdin: std::sync::Arc<AsyncMutex<ChildStdin>>,
    request_id: &str,
    text: &str,
) -> Result<(), String> {
    push_event(
        "info",
        format!(
            "正在发送钉钉处理中提示，request_id={}，preview={}",
            request_id,
            preview_text(text, 120)
        ),
    );

    let command = json!({
        "type": "notify_text",
        "requestId": request_id,
        "text": trim_reply(text),
    });
    let serialized = serde_json::to_string(&command)
        .map_err(|error| format!("Failed to serialize DingTalk worker command: {error}"))?;

    let mut writer = stdin.lock().await;
    writer
        .write_all(format!("{serialized}\n").as_bytes())
        .await
        .map_err(|error| format!("Failed to write to DingTalk worker stdin: {error}"))?;
    writer
        .flush()
        .await
        .map_err(|error| format!("Failed to flush DingTalk worker stdin: {error}"))?;

    Ok(())
}

async fn handle_incoming_message(
    app: AppHandle,
    stdin: std::sync::Arc<AsyncMutex<ChildStdin>>,
    message: IncomingDingTalkMessage,
) {
    let started_at = Instant::now();
    push_event(
        "info",
        format!(
            "收到钉钉消息，sender={}，group={}，preview={}",
            message
                .sender_nick
                .clone()
                .unwrap_or_else(|| message.sender_id.clone()),
            message.is_group,
            preview_text(&message.text, 120)
        ),
    );

    let normalized_text = normalize_incoming_text(&message.text);
    let request_id = message.request_id.clone();

    if sender_allowed(&message)
        && chat_allowed(&message)
        && should_send_processing_notice(&normalized_text)
    {
        if let Err(error) =
            send_worker_notice(stdin.clone(), &request_id, &processing_reply_text()).await
        {
            log_warn(format!("发送钉钉处理中提示失败：{error}"));
            push_event("warn", format!("发送钉钉处理中提示失败：{error}"));
        } else {
            push_event(
                "info",
                format!(
                    "已发送钉钉处理中提示，request_id={}，elapsed_ms={}",
                    request_id,
                    started_at.elapsed().as_millis()
                ),
            );
        }
    }

    let reply_started_at = Instant::now();
    let reply = match build_reply_for_message(&app, &message).await {
        Ok(reply) => reply,
        Err(error) => {
            log_error(format!("处理钉钉消息失败：{error}"));
            format!("请求失败：{error}")
        }
    };

    push_event(
        "info",
        format!(
            "钉钉消息已完成处理，request_id={}，reply_chars={}，build_ms={}，total_ms={}",
            request_id,
            reply.chars().count(),
            reply_started_at.elapsed().as_millis(),
            started_at.elapsed().as_millis()
        ),
    );

    if let Err(error) = send_worker_reply(stdin, &message.request_id, &reply).await {
        log_error(format!("发送钉钉回复失败：{error}"));
        push_event("error", format!("发送钉钉回复失败：{error}"));
    }
}

async fn read_worker_stdout(
    app: AppHandle,
    stdin: std::sync::Arc<AsyncMutex<ChildStdin>>,
    stdout: ChildStdout,
) {
    let mut lines = BufReader::new(stdout).lines();

    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                if line.trim().is_empty() {
                    continue;
                }

                log_info(format!(
                    "[dingtalk][worker-stdout] {}",
                    preview_text(&line, 400)
                ));

                let payload: Value = match serde_json::from_str(&line) {
                    Ok(value) => value,
                    Err(error) => {
                        push_event("error", format!("Invalid DingTalk worker JSON: {error}"));
                        continue;
                    }
                };

                let event_type = payload
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");

                match event_type {
                    "ready" | "log" | "sent" => {
                        let level = payload
                            .get("level")
                            .and_then(Value::as_str)
                            .unwrap_or("info");
                        let message = payload
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("DingTalk worker event");
                        push_event(level, message.to_string());
                    }
                    "error" => {
                        let message = payload
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("DingTalk worker error");
                        push_event("error", message.to_string());
                    }
                    "incoming_message" => {
                        match serde_json::from_value::<IncomingDingTalkMessage>(payload) {
                            Ok(message) => {
                                tokio::spawn(handle_incoming_message(
                                    app.clone(),
                                    stdin.clone(),
                                    message,
                                ));
                            }
                            Err(error) => {
                                push_event(
                                    "error",
                                    format!("解析 incoming DingTalk message 失败：{error}"),
                                );
                            }
                        }
                    }
                    other => {
                        push_event("warn", format!("未知的 DingTalk worker 事件：{other}"));
                    }
                }
            }
            Ok(None) => {
                break;
            }
            Err(error) => {
                push_event(
                    "error",
                    format!("读取 DingTalk worker stdout 失败：{error}"),
                );
                break;
            }
        }
    }

    set_running(false, "DingTalk 中继已停止。");
    if let Ok(mut runtime) = DINGTALK_RUNTIME.lock() {
        *runtime = None;
    }
}

async fn read_worker_stderr(stderr: ChildStderr) {
    let mut lines = BufReader::new(stderr).lines();

    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                if !line.trim().is_empty() {
                    log_warn(format!(
                        "[dingtalk][worker-stderr] {}",
                        preview_text(&line, 400)
                    ));
                    push_event("info", format!("[worker] {line}"));
                }
            }
            Ok(None) => break,
            Err(error) => {
                push_event(
                    "error",
                    format!("读取 DingTalk worker stderr 失败：{error}"),
                );
                break;
            }
        }
    }
}

pub(crate) fn get_status() -> DingTalkStatus {
    status_snapshot()
}

pub(crate) async fn start_service(app: &AppHandle) -> Result<DingTalkStatus, String> {
    ensure_license_valid(app)?;
    ensure_authenticated(app)?;

    if !dingtalk_configured() {
        return Err(format!(
            "缺少 DingTalk 凭据，请在 .env 中设置 {} 和 {}。",
            DINGTALK_CLIENT_ID_ENV, DINGTALK_CLIENT_SECRET_ENV
        ));
    }

    if let Ok(runtime) = DINGTALK_RUNTIME.lock() {
        if runtime.is_some() {
            return Ok(status_snapshot());
        }
    }

    let script_path = dingtalk_script_path().ok_or_else(|| {
        format!("未找到 DingTalk worker 脚本：{DINGTALK_STREAM_SCRIPT_RELATIVE_PATH}")
    })?;

    let client_id = read_env_var(DINGTALK_CLIENT_ID_ENV)
        .ok_or_else(|| format!("Missing env {DINGTALK_CLIENT_ID_ENV}"))?;
    let client_secret = read_env_var(DINGTALK_CLIENT_SECRET_ENV)
        .ok_or_else(|| format!("Missing env {DINGTALK_CLIENT_SECRET_ENV}"))?;

    let args = vec![
        "--client-id".to_string(),
        client_id,
        "--client-secret".to_string(),
        client_secret,
    ];

    log_info(format!(
        "[dingtalk] starting worker, script_path={}, mode={}, remote_commands_enabled={}, remote_search_enabled={}, processing_notice_enabled={}, command_prefixes={}",
        script_path.display(),
        configured_mode().label(),
        parse_bool_env(DINGTALK_ENABLE_REMOTE_COMMANDS_ENV),
        remote_search_enabled(),
        processing_reply_enabled(),
        {
            let prefixes = remote_command_prefixes();
            if prefixes.is_empty() {
                "(none)".to_string()
            } else {
                prefixes.join(", ")
            }
        }
    ));

    let mut child = start_python_script(&script_path, &args).await?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法捕获 DingTalk worker stdout。".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法捕获 DingTalk worker stderr。".to_string())?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "无法捕获 DingTalk worker stdin。".to_string())?;

    clear_remote_sessions();

    let runtime = DingTalkRuntime {
        child: std::sync::Arc::new(AsyncMutex::new(child)),
        stdin: std::sync::Arc::new(AsyncMutex::new(stdin)),
    };

    {
        let mut slot = DINGTALK_RUNTIME
            .lock()
            .map_err(|_| "DingTalk runtime state is poisoned.".to_string())?;
        *slot = Some(runtime.clone());
    }

    set_running(true, "DingTalk 中继启动中。");
    push_event(
        "info",
        format!("已启动 DingTalk worker：{}", script_path.display()),
    );

    tokio::spawn(read_worker_stdout(
        app.clone(),
        runtime.stdin.clone(),
        stdout,
    ));
    tokio::spawn(read_worker_stderr(stderr));

    Ok(status_snapshot())
}

pub(crate) async fn stop_service() -> Result<DingTalkStatus, String> {
    let runtime = {
        let mut slot = DINGTALK_RUNTIME
            .lock()
            .map_err(|_| "DingTalk 运行时状态已损坏。".to_string())?;
        slot.take()
    };

    clear_remote_sessions();

    if let Some(runtime) = runtime {
        let mut child = runtime.child.lock().await;
        if let Err(error) = child.start_kill() {
            push_event("error", format!("停止 DingTalk worker 失败：{error}"));
        }
        if let Err(error) = child.wait().await {
            push_event("error", format!("等待 DingTalk worker 退出失败：{error}"));
        }
    }

    if let Ok(mut state) = DINGTALK_STATE.lock() {
        state.running = false;
        state.message = "DingTalk 中继已停止。".to_string();
    }
    push_event("info", "DingTalk 中继已停止。");

    Ok(status_snapshot())
}
