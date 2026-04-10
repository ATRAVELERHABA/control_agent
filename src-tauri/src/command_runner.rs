//! 负责终端命令执行、流式读取与输出解码。

use std::process::Stdio;

#[cfg(target_os = "windows")]
use base64::{engine::general_purpose::STANDARD, Engine as _};
#[cfg(target_os = "windows")]
use encoding_rs::GBK;
use tauri::AppHandle;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    task::JoinHandle,
};

use crate::{
    events::emit_stream_event,
    logging::{log_error, log_info, preview_text},
    models::{AgentStreamEvent, RunCommandRequest},
};

/// 在 Windows 下将 PowerShell 命令编码为 UTF-16LE Base64。
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

/// 尝试按多种编码规则将命令输出字节解码为文本。
pub(crate) fn decode_command_output(bytes: &[u8]) -> String {
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

/// 去掉命令输出行尾的换行与空字符。
fn normalize_stream_line(text: &str) -> String {
    text.trim_end_matches(['\r', '\n', '\0']).to_string()
}

/// 按行读取子进程输出，并实时推送到前端。
async fn read_command_stream<R>(
    reader: R,
    app: AppHandle,
    stream_id: Option<String>,
    command_id: Option<String>,
    stream_kind: &'static str,
) -> Result<String, String>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    let mut reader = BufReader::new(reader);
    let mut buffer = Vec::<u8>::new();
    let mut collected = String::new();

    loop {
        buffer.clear();
        let bytes_read = reader
            .read_until(b'\n', &mut buffer)
            .await
            .map_err(|error| format!("读取 {stream_kind} 输出失败：{error}"))?;

        if bytes_read == 0 {
            break;
        }

        let line = normalize_stream_line(&decode_command_output(&buffer));

        if let (Some(stream_id), Some(command_id)) = (&stream_id, &command_id) {
            emit_stream_event(
                &app,
                AgentStreamEvent::CommandOutput {
                    stream_id: stream_id.clone(),
                    command_id: command_id.clone(),
                    stream_kind: stream_kind.to_string(),
                    line: line.clone(),
                },
            )?;
        }

        collected.push_str(&line);
        collected.push('\n');
    }

    Ok(collected.trim_end_matches('\n').to_string())
}

/// 在当前平台的系统 Shell 中执行终端命令。
pub(crate) async fn execute_shell_command(
    app: &AppHandle,
    request: RunCommandRequest,
) -> Result<String, String> {
    let command = request.command.trim().to_string();

    if command.is_empty() {
        return Err("Command cannot be empty.".to_string());
    }

    log_info(format!(
        "开始异步执行终端命令：{}, stream_id={:?}, command_id={:?}",
        command, request.stream_id, request.command_id
    ));

    let mut child = if cfg!(target_os = "windows") {
        let encoded_command = encode_powershell_command(&command);

        let mut cmd = Command::new("powershell");
        cmd.arg("-NoProfile")
            .arg("-NonInteractive")
            .arg("-EncodedCommand")
            .arg(encoded_command);
        cmd
    } else if cfg!(target_os = "linux") || cfg!(target_os = "macos") {
        let mut cmd = Command::new("bash");
        cmd.arg("-c").arg(&command);
        cmd
    } else {
        return Err("Unsupported operating system".to_string());
    };

    child.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = child
        .spawn()
        .map_err(|error| format!("Failed to execute command: {error}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法获取子进程 stdout。".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法获取子进程 stderr。".to_string())?;

    let stdout_handle: JoinHandle<Result<String, String>> = tokio::spawn(read_command_stream(
        stdout,
        app.clone(),
        request.stream_id.clone(),
        request.command_id.clone(),
        "stdout",
    ));
    let stderr_handle: JoinHandle<Result<String, String>> = tokio::spawn(read_command_stream(
        stderr,
        app.clone(),
        request.stream_id.clone(),
        request.command_id.clone(),
        "stderr",
    ));

    let status = child
        .wait()
        .await
        .map_err(|error| format!("等待子进程结束失败：{error}"))?;

    let stdout = stdout_handle
        .await
        .map_err(|error| format!("等待 stdout 任务失败：{error}"))??;
    let stderr = stderr_handle
        .await
        .map_err(|error| format!("等待 stderr 任务失败：{error}"))??;

    if let (Some(stream_id), Some(command_id)) = (&request.stream_id, &request.command_id) {
        emit_stream_event(
            app,
            AgentStreamEvent::CommandComplete {
                stream_id: stream_id.clone(),
                command_id: command_id.clone(),
                success: status.success(),
            },
        )?;
    }

    if status.success() {
        log_info(format!(
            "终端命令异步执行成功，command={}, stdout_preview={}",
            command,
            preview_text(&stdout, 200)
        ));
        Ok(stdout)
    } else if stderr.is_empty() {
        log_error(format!(
            "终端命令异步执行失败但 stderr 为空，command={}",
            command
        ));
        Err("Command failed without stderr output.".to_string())
    } else {
        log_error(format!(
            "终端命令异步执行失败，command={}, stderr_preview={}",
            command,
            preview_text(&stderr, 200)
        ));
        Err(stderr)
    }
}
