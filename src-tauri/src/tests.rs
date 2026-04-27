//! 收敛跨模块的基础单元测试。

use crate::{
    command_runner::decode_command_output,
    constants::{ALIYUN_DASHSCOPE_BASE_URL, ALIYUN_DASHSCOPE_MODEL},
    llm::{build_chat_completions_url, parse_non_stream_completion_payload, parse_tool_command},
    models::{DuckDuckGoSearchPayload, DuckDuckGoSearchResult},
    search::format_duckduckgo_search_results,
    system_time::format_system_time_output_for_test,
    webpage::extract_html_content_for_test,
};
use serde_json::json;

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
fn parses_non_stream_completion_text_payload() {
    let completion = parse_non_stream_completion_payload(json!({
        "choices": [
            {
                "message": {
                    "content": "hello from json"
                }
            }
        ]
    }))
    .unwrap();

    assert_eq!(completion.content, "hello from json");
    assert!(completion.tool_calls.is_empty());
}

#[test]
fn parses_non_stream_completion_tool_calls_payload() {
    let completion = parse_non_stream_completion_payload(json!({
        "choices": [
            {
                "message": {
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "type": "function",
                            "function": {
                                "name": "duckduckgo_search",
                                "arguments": "{\"query\":\"test\"}"
                            }
                        }
                    ]
                }
            }
        ]
    }))
    .unwrap();

    assert_eq!(completion.tool_calls.len(), 1);
    assert_eq!(completion.tool_calls[0].function.name, "duckduckgo_search");
}

#[test]
fn formats_duckduckgo_search_results() {
    let formatted = format_duckduckgo_search_results(DuckDuckGoSearchPayload {
        query: "openai api".to_string(),
        results: vec![DuckDuckGoSearchResult {
            title: "OpenAI API".to_string(),
            url: "https://platform.openai.com/".to_string(),
            snippet: "Build with the OpenAI API.".to_string(),
        }],
    });

    assert!(formatted.contains("DuckDuckGo 搜索结果：openai api"));
    assert!(formatted.contains("1. OpenAI API"));
    assert!(formatted.contains("链接: https://platform.openai.com/"));
}

#[test]
fn aliyun_dashscope_fallback_constants_are_expected() {
    assert_eq!(
        ALIYUN_DASHSCOPE_BASE_URL,
        "https://dashscope.aliyuncs.com/compatible-mode/v1"
    );
    assert_eq!(ALIYUN_DASHSCOPE_MODEL, "qwen3-max");
}

#[test]
fn extracts_readable_webpage_content() {
    let html = r#"
        <html>
            <head>
                <title>Example Article</title>
                <meta name="description" content="A short summary." />
            </head>
            <body>
                <main>
                    <h1>Example Article</h1>
                    <p>First paragraph.</p>
                    <p>Second paragraph with more detail.</p>
                </main>
            </body>
        </html>
    "#;

    let output = extract_html_content_for_test(
        "https://example.com/article",
        "text/html; charset=utf-8",
        html,
    );

    assert!(output.contains("URL: https://example.com/article"));
    assert!(output.contains("标题: Example Article"));
    assert!(output.contains("摘要: A short summary."));
    assert!(output.contains("First paragraph."));
    assert!(output.contains("Second paragraph with more detail."));
}

#[test]
fn formats_current_system_time_output() {
    let output = format_system_time_output_for_test();

    assert!(output.contains("Current system time"));
    assert!(output.contains("Local time:"));
    assert!(output.contains("UTC time:"));
    assert!(output.contains("Unix timestamp:"));
    assert!(output.contains("Timezone offset:"));
}
