//! 负责 OpenAI 兼容接口通信、SSE 流解析与工具调用聚合。

use std::collections::BTreeMap;

use futures_util::StreamExt;
use reqwest::{header, Client, Response};
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::{
    env::build_runtime_environment_prompt,
    events::emit_stream_event,
    logging::{log_error, log_info, preview_text},
    models::{
        AgentStreamEvent, ChatCompletionChunk, ConversationMessageDto, ProviderConfig,
        SkillDefinition, SkillType, StreamCompletionResult, ToolArguments, ToolCallChunk,
        ToolCallDto, ToolFunctionDto,
    },
};

/// 读取响应头中的 Content-Type，便于决定解析策略。
fn response_content_type(response: &Response) -> String {
    response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string()
}

/// 将模型配置中的 base_url 规范化为 chat/completions 完整地址。
pub(crate) fn build_chat_completions_url(base_url: &str) -> String {
    if base_url.ends_with("/chat/completions") {
        base_url.to_string()
    } else {
        format!("{}/chat/completions", base_url.trim_end_matches('/'))
    }
}

/// 将已启用的工具型技能转换成模型可识别的 tools 数组。
fn openai_tools_payload(skills: &[SkillDefinition]) -> Value {
    Value::Array(
        skills
            .iter()
            .filter(|skill| matches!(skill.skill_type, SkillType::Tool))
            .filter_map(|skill| skill.tool.as_ref())
            .map(|tool| {
                json!({
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.parameters
                    }
                })
            })
            .collect::<Vec<_>>(),
    )
}

/// 构建请求模型接口所需的 HTTP Header。
pub(crate) fn build_request_headers(config: &ProviderConfig) -> header::HeaderMap {
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

/// 将前端消息结构转换为 OpenAI 兼容接口的消息 JSON。
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

/// 构建最终发送给模型的消息列表。
fn build_openai_messages(
    app: &AppHandle,
    messages: &[ConversationMessageDto],
    skills: &[SkillDefinition],
) -> Result<Vec<Value>, String> {
    let system_prompt = build_runtime_environment_prompt(app, skills);
    log_info(format!(
        "已注入系统环境提示词，preview={}",
        preview_text(&system_prompt, 240)
    ));

    let mut request_messages = vec![json!({
        "role": "system",
        "content": system_prompt,
    })];

    for message in messages {
        request_messages.push(frontend_message_to_openai_value(message)?);
    }

    Ok(request_messages)
}

/// 从失败的 HTTP 响应中提取更友好的错误消息。
pub(crate) async fn extract_response_error(response: Response) -> String {
    let status = response.status();
    let content_type = response_content_type(&response);
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
        log_error(format!(
            "模型接口返回错误，status={}，且响应体为空。",
            status
        ));
        format!("模型请求失败，状态码：{status}")
    }
}

/// 从普通 completion 响应中的 `content` 字段提取文本。
fn extract_completion_text(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.to_string();
    }

    if let Some(parts) = content.as_array() {
        return parts
            .iter()
            .filter_map(|part| {
                part.get("text")
                    .and_then(Value::as_str)
                    .or_else(|| part.get("content").and_then(Value::as_str))
            })
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string();
    }

    String::new()
}

/// 解析一次性 JSON completion 响应。
pub(crate) fn parse_non_stream_completion_payload(
    payload: Value,
) -> Result<StreamCompletionResult, String> {
    let choice = payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .ok_or_else(|| "模型响应中缺少 choices[0]。".to_string())?;

    let message = choice
        .get("message")
        .or_else(|| choice.get("delta"))
        .unwrap_or(choice);

    let content = message
        .get("content")
        .map(extract_completion_text)
        .unwrap_or_default();

    let tool_calls = if let Some(raw_tool_calls) = message.get("tool_calls") {
        serde_json::from_value(raw_tool_calls.clone())
            .map_err(|error| format!("解析普通 JSON tool_calls 失败：{error}"))?
    } else {
        Vec::<ToolCallDto>::new()
    };

    Ok(StreamCompletionResult {
        content,
        tool_calls,
    })
}

/// 在 SSE 原始字节流中查找一个完整事件边界。
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

/// 从单个 SSE 事件原文中提取 data 字段正文。
fn parse_sse_event_data(raw_event: &str) -> String {
    raw_event
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(str::trim)
        .collect::<Vec<_>>()
        .join("\n")
}

/// 将工具调用增量分片合并为完整的工具调用对象。
fn merge_tool_call_chunk(
    tool_calls_by_index: &mut BTreeMap<usize, ToolCallDto>,
    chunk: ToolCallChunk,
) {
    let index = chunk.index.unwrap_or(0);
    let current = tool_calls_by_index
        .entry(index)
        .or_insert_with(|| ToolCallDto {
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

/// 在流式解析失败时，尝试从残留 buffer 中兜底解析结果。
fn parse_buffer_fallback(buffer: &[u8]) -> Result<Option<StreamCompletionResult>, String> {
    let raw_text = String::from_utf8_lossy(buffer).trim().to_string();

    if raw_text.is_empty() {
        return Ok(None);
    }

    if raw_text.contains("data:") {
        let normalized = raw_text.replace("\r\n", "\n");
        let raw_events = normalized
            .split("\n\n")
            .filter(|event| !event.trim().is_empty())
            .collect::<Vec<_>>();
        let events = if raw_events.is_empty() {
            vec![normalized.as_str()]
        } else {
            raw_events
        };

        let mut content = String::new();
        let mut tool_calls_by_index = BTreeMap::<usize, ToolCallDto>::new();

        for raw_event in events {
            let event_data = parse_sse_event_data(raw_event);

            if event_data.is_empty() || event_data == "[DONE]" {
                continue;
            }

            let chunk: ChatCompletionChunk =
                serde_json::from_str(&event_data).map_err(|error| {
                    format!("兜底解析 SSE 事件失败：{error}\n原始数据：{event_data}")
                })?;

            if let Some(choice) = chunk.choices.into_iter().next() {
                if let Some(delta) = choice.delta.content {
                    content.push_str(&delta);
                }

                if let Some(tool_calls) = choice.delta.tool_calls {
                    for tool_call in tool_calls {
                        merge_tool_call_chunk(&mut tool_calls_by_index, tool_call);
                    }
                }
            }
        }

        return Ok(Some(StreamCompletionResult {
            content,
            tool_calls: tool_calls_by_index.into_values().collect(),
        }));
    }

    let payload: Value = serde_json::from_str(&raw_text)
        .map_err(|error| format!("兜底解析普通 JSON 响应失败：{error}\n原始数据：{raw_text}"))?;

    Ok(Some(parse_non_stream_completion_payload(payload)?))
}

/// 流式请求模型接口，并实时向前端转发增量输出。
pub(crate) async fn stream_chat_completion(
    app: &AppHandle,
    client: &Client,
    config: &ProviderConfig,
    stream_id: &str,
    messages: &[ConversationMessageDto],
    skills: &[SkillDefinition],
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
            "messages": build_openai_messages(app, messages, skills)?,
            "tools": openai_tools_payload(skills),
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

    let content_type = response_content_type(&response);

    if !content_type.contains("text/event-stream") {
        log_info(format!(
            "检测到非 SSE 响应，stream_id={}, content_type={}",
            stream_id, content_type
        ));

        let payload: Value = response
            .json()
            .await
            .map_err(|error| format!("解析普通 JSON completion 响应失败：{error}"))?;
        let completion = parse_non_stream_completion_payload(payload)?;

        emit_stream_event(
            app,
            AgentStreamEvent::AssistantComplete {
                stream_id: stream_id.to_string(),
                content: completion.content.clone(),
                has_tool_calls: !completion.tool_calls.is_empty(),
            },
        )?;

        log_info(format!(
            "普通 JSON completion 完成，stream_id={}, content_preview={}, tool_calls={}",
            stream_id,
            preview_text(&completion.content, 160),
            completion.tool_calls.len()
        ));

        return Ok(completion);
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

            let chunk: ChatCompletionChunk =
                serde_json::from_str(&event_data).map_err(|error| {
                    format!("解析模型流式数据失败：{error}\n原始数据：{event_data}")
                })?;

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

    if (!buffer.is_empty()) && content.is_empty() && tool_calls_by_index.is_empty() {
        if let Some(fallback_completion) = parse_buffer_fallback(&buffer)? {
            log_info(format!(
                "流式响应触发兜底解析，stream_id={}, content_preview={}, tool_calls={}",
                stream_id,
                preview_text(&fallback_completion.content, 160),
                fallback_completion.tool_calls.len()
            ));
            content = fallback_completion.content;
            tool_calls_by_index = fallback_completion
                .tool_calls
                .into_iter()
                .enumerate()
                .map(|(index, tool_call)| (index, tool_call))
                .collect();
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

/// 解析终端工具的参数 JSON，并抽取命令文本。
pub(crate) fn parse_tool_command(arguments_text: &str) -> Result<String, String> {
    let parsed: ToolArguments = serde_json::from_str(arguments_text)
        .map_err(|error| format!("模型返回的工具参数不是合法 JSON：{error}"))?;
    let command = parsed.command.trim().to_string();

    if command.is_empty() {
        return Err("工具参数中的 command 不能为空。".to_string());
    }

    Ok(command)
}
