//! 提供统一的日志输出与文本预览工具。

use std::time::{SystemTime, UNIX_EPOCH};

/// 生成当前毫秒级时间戳，用于日志打点。
pub(crate) fn timestamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

/// 输出普通信息日志。
pub(crate) fn log_info(message: impl AsRef<str>) {
    println!("[agent][{}] {}", timestamp_ms(), message.as_ref());
}

/// 输出错误级别日志。
pub(crate) fn log_error(message: impl AsRef<str>) {
    eprintln!("[agent][{}][error] {}", timestamp_ms(), message.as_ref());
}

/// 生成文本预览，避免日志里打印完整长文本。
pub(crate) fn preview_text(text: &str, max_chars: usize) -> String {
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

/// 对密钥做脱敏展示，避免日志泄漏完整凭证。
pub(crate) fn redact_secret(secret: &str) -> String {
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
