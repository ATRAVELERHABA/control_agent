//! Unified backend logging helpers.

use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) fn timestamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

pub(crate) fn log_info(message: impl AsRef<str>) {
    println!("[agent][{}] {}", timestamp_ms(), message.as_ref());
}

pub(crate) fn log_warn(message: impl AsRef<str>) {
    println!("[agent][{}][warn] {}", timestamp_ms(), message.as_ref());
}

pub(crate) fn log_error(message: impl AsRef<str>) {
    eprintln!("[agent][{}][error] {}", timestamp_ms(), message.as_ref());
}

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
