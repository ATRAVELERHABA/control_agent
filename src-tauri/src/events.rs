//! 封装后端向前端发送流式事件的公共能力。

use tauri::{AppHandle, Emitter};

use crate::{constants::STREAM_EVENT_NAME, models::AgentStreamEvent};

/// 将后端事件发送给前端监听器。
pub(crate) fn emit_stream_event(app: &AppHandle, event: AgentStreamEvent) -> Result<(), String> {
    app.emit(STREAM_EVENT_NAME, event)
        .map_err(|error| format!("发送流式事件失败：{error}"))
}
