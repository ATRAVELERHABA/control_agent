//! 负责 Tauri 命令注册与后端高层工作流编排。

use reqwest::Client;
use tauri::AppHandle;

use crate::{
    activation::{
        clear_license as clear_license_state, ensure_license_valid,
        get_license_status as read_license_status, import_license as import_license_file,
    },
    auth::{
        clear_session, ensure_authenticated, get_current_user as read_current_user,
        get_session_status as read_session_status, login as login_local_account,
        logout as logout_local_account, register_account as register_local_account,
    },
    assets::register_asset as store_asset,
    audio::transcribe_audio,
    command_runner::execute_shell_command,
    constants::TOOL_NAME,
    env::{load_backend_env_once, load_provider_config, provider_status},
    events::emit_stream_event,
    llm::{parse_tool_command, stream_chat_completion},
    logging::{log_error, log_info, preview_text},
    models::{
        AgentMode, AgentStreamEvent, AgentTurnRequest, AgentTurnResult, AnalyzeImageRequest,
        AssetSummary, BackendModeStatuses, ConversationMessageDto, CurrentUser, ImportLicenseRequest,
        ImportLicenseResult, LicenseStatus, LoginRequest, RegisterAccountRequest,
        RegisterAssetRequest, RunCommandRequest, RunDuckDuckGoSearchRequest, SessionStatus,
        SkillSummary, TranscribeAudioRequest, UpdateSkillEnabledRequest,
    },
    search::execute_duckduckgo_search,
    skills::{load_skill_definitions, load_skill_summaries, set_skill_enabled},
    vision::analyze_image,
};

/// 读取两种后端模式的当前配置状态。
#[tauri::command]
fn get_license_status(app: AppHandle) -> Result<LicenseStatus, String> {
    read_license_status(&app)
}

#[tauri::command]
fn import_license(
    app: AppHandle,
    request: ImportLicenseRequest,
) -> Result<ImportLicenseResult, String> {
    import_license_file(&app, request)
}

#[tauri::command]
fn clear_license(app: AppHandle) -> Result<LicenseStatus, String> {
    clear_session(&app)?;
    clear_license_state(&app)
}

#[tauri::command]
fn get_session_status(app: AppHandle) -> Result<SessionStatus, String> {
    read_session_status(&app)
}

#[tauri::command]
fn register_account(
    app: AppHandle,
    request: RegisterAccountRequest,
) -> Result<SessionStatus, String> {
    ensure_license_valid(&app)?;
    register_local_account(&app, request)
}

#[tauri::command]
fn login(app: AppHandle, request: LoginRequest) -> Result<SessionStatus, String> {
    login_local_account(&app, request)
}

#[tauri::command]
fn logout(app: AppHandle) -> Result<SessionStatus, String> {
    logout_local_account(&app)
}

#[tauri::command]
fn get_current_user(app: AppHandle) -> Result<CurrentUser, String> {
    read_current_user(&app)
}

#[tauri::command]
fn get_backend_mode_statuses(app: AppHandle) -> Result<BackendModeStatuses, String> {
    ensure_license_valid(&app)?;
    ensure_authenticated(&app)?;
    log_info("前端请求读取后端模式状态。");
    Ok(BackendModeStatuses {
        online: provider_status(AgentMode::Online),
        local: provider_status(AgentMode::Local),
    })
}

/// 读取技能摘要列表。
#[tauri::command]
fn get_skill_summaries(app: AppHandle) -> Result<Vec<SkillSummary>, String> {
    ensure_license_valid(&app)?;
    ensure_authenticated(&app)?;
    log_info("前端请求读取技能列表。");
    Ok(load_skill_summaries())
}

/// 更新单个技能的启用状态。
#[tauri::command]
fn update_skill_enabled(
    app: AppHandle,
    request: UpdateSkillEnabledRequest,
) -> Result<SkillSummary, String> {
    ensure_license_valid(&app)?;
    ensure_authenticated(&app)?;
    log_info(format!(
        "前端请求更新技能开关，id={}, enabled={}",
        request.skill_id, request.enabled
    ));
    set_skill_enabled(&request.skill_id, request.enabled)
}

/// 注册一份前端上传的附件，生成可供工具调用的 `asset_id`。
#[tauri::command]
fn register_asset(app: AppHandle, request: RegisterAssetRequest) -> Result<AssetSummary, String> {
    ensure_license_valid(&app)?;
    ensure_authenticated(&app)?;
    log_info(format!(
        "前端请求注册附件，file_name={}, mime_type={}, bytes={}",
        request.file_name,
        request.mime_type,
        request.bytes.len()
    ));
    store_asset(request)
}

/// 执行一轮模型推理，并在需要时返回工具调用。
#[tauri::command]
async fn run_agent_turn(
    app: AppHandle,
    request: AgentTurnRequest,
) -> Result<AgentTurnResult, String> {
    ensure_license_valid(&app)?;
    ensure_authenticated(&app)?;
    log_info(format!(
        "开始执行代理轮次，stream_id={}, mode={}, input_messages={}",
        request.stream_id,
        request.mode.label(),
        request.messages.len()
    ));
    let config = load_provider_config(request.mode)?;
    let skills = load_skill_definitions();
    let client = Client::builder()
        .build()
        .map_err(|error| format!("创建 HTTP 客户端失败：{error}"))?;

    log_info(format!(
        "执行单轮模型推理，stream_id={}, input_messages={}",
        request.stream_id,
        request.messages.len()
    ));
    let completion = stream_chat_completion(
        &app,
        &client,
        &config,
        &request.stream_id,
        &request.messages,
        &skills,
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
    } else {
        let requested_tools = completion
            .tool_calls
            .iter()
            .map(|tool_call| tool_call.function.name.clone())
            .collect::<Vec<_>>();
        log_info(format!(
            "模型请求调用工具，stream_id={}, tools={}",
            request.stream_id,
            requested_tools.join(", ")
        ));

        for tool_call in &completion.tool_calls {
            if tool_call.function.name != TOOL_NAME {
                continue;
            }

            match parse_tool_command(&tool_call.function.arguments) {
                Ok(command) => {
                    log_info(format!(
                        "模型请求前端确认执行命令，stream_id={}, command={}",
                        request.stream_id, command
                    ));
                    emit_stream_event(
                        &app,
                        AgentStreamEvent::ToolCall {
                            stream_id: request.stream_id.clone(),
                            tool_name: tool_call.function.name.clone(),
                            command,
                        },
                    )?;
                }
                Err(error) => {
                    log_error(format!(
                        "工具参数解析失败，stream_id={}, error={}",
                        request.stream_id, error
                    ));
                }
            }
        }

        emit_stream_event(
            &app,
            AgentStreamEvent::Status {
                stream_id: request.stream_id.clone(),
                message: format!(
                    "模型请求调用工具：{}，等待前端执行。",
                    requested_tools.join(", ")
                ),
            },
        )?;
    }

    Ok(AgentTurnResult {
        new_messages: vec![assistant_message],
    })
}

/// 执行一次 DuckDuckGo 搜索。
#[tauri::command]
async fn run_duckduckgo_search(
    app: AppHandle,
    request: RunDuckDuckGoSearchRequest,
) -> Result<String, String> {
    ensure_license_valid(&app)?;
    ensure_authenticated(&app)?;
    execute_duckduckgo_search(request).await
}

/// 执行一次图像识别。
#[tauri::command]
async fn run_analyze_image(
    app: AppHandle,
    request: AnalyzeImageRequest,
) -> Result<String, String> {
    ensure_license_valid(&app)?;
    ensure_authenticated(&app)?;
    analyze_image(request).await
}

/// 执行一次音频转写。
#[tauri::command]
async fn run_transcribe_audio(
    app: AppHandle,
    request: TranscribeAudioRequest,
) -> Result<String, String> {
    ensure_license_valid(&app)?;
    ensure_authenticated(&app)?;
    transcribe_audio(request).await
}

/// 执行一次终端命令。
#[tauri::command]
async fn run_command(app: AppHandle, request: RunCommandRequest) -> Result<String, String> {
    ensure_license_valid(&app)?;
    ensure_authenticated(&app)?;
    execute_shell_command(&app, request).await
}

/// 启动 Tauri 后端并注册全部命令。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    load_backend_env_once();
    log_info("Tauri 后端已启动，等待前端调用。");

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_license_status,
            import_license,
            clear_license,
            get_session_status,
            register_account,
            login,
            logout,
            get_current_user,
            get_backend_mode_statuses,
            get_skill_summaries,
            update_skill_enabled,
            register_asset,
            run_agent_turn,
            run_duckduckgo_search,
            run_analyze_image,
            run_transcribe_audio,
            run_command
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
