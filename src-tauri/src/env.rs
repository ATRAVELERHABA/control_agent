//! Backend environment loading and provider configuration helpers.

use std::{
    collections::{HashMap, HashSet},
    env, fs,
    io::Cursor,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex, Once, OnceLock},
};

use tauri::AppHandle;

use crate::{
    constants::{
        ALIYUN_DASHSCOPE_BASE_URL, ALIYUN_DASHSCOPE_MODEL, LICENSE_PUBLIC_KEY_ENV_NAME,
        TOOL_AGNOSTIC_SYSTEM_PROMPT,
    },
    logging::{log_error, log_info, redact_secret},
    models::{
        AgentMode, BackendEnvStatus, BackendModeStatus, BackendModeStatuses,
        ImportBackendEnvRequest, ImportBackendEnvResult, ProviderConfig, SkillDefinition,
    },
    runtime_paths::{app_data_dir, config_root_candidates},
    settings::read_custom_system_prompt,
    skills::{build_prompt_skill_section, build_tool_skill_section},
};

static ENV_LOADED: Once = Once::new();
static ENV_RELOAD_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
static ORIGINAL_MANAGED_ENV: OnceLock<HashMap<String, Option<String>>> = OnceLock::new();

const MANAGED_ENV_KEYS: &[&str] = &[
    "OPENAI_BASE_URL",
    "OPENAI_MODEL",
    "OPENAI_API_KEY",
    "OPENAI_VISION_MODEL",
    "OPENAI_AUDIO_MODEL",
    "ALIYUN_API_KEY",
    "ALIYUN_MODEL",
    "ALIYUN_VISION_MODEL",
    "ALIYUN_AUDIO_MODEL",
    "OLLAMA_BASE_URL",
    "OLLAMA_MODEL",
    "OLLAMA_API_KEY",
    "OLLAMA_VISION_MODEL",
    "LOCAL_AUDIO_MODEL",
    "DINGTALK_CLIENT_ID",
    "DINGTALK_CLIENT_SECRET",
    "DINGTALK_AGENT_MODE",
    "DINGTALK_ALLOWED_SENDERS",
    "DINGTALK_ALLOWED_CHATS",
    "DINGTALK_ENABLE_REMOTE_COMMANDS",
    "DINGTALK_ALLOWED_COMMAND_PREFIXES",
    "DINGTALK_ENABLE_REMOTE_SEARCH",
    "DINGTALK_SEND_PROCESSING_REPLY",
    "DINGTALK_PROCESSING_REPLY_TEXT",
    LICENSE_PUBLIC_KEY_ENV_NAME,
];

fn strip_wrapping_quotes(value: &str) -> String {
    value.trim_matches('"').to_string()
}

fn detect_linux_distribution() -> Option<String> {
    if !cfg!(target_os = "linux") {
        return None;
    }

    let contents = fs::read_to_string("/etc/os-release").ok()?;
    let mut pretty_name = None;
    let mut name = None;
    let mut version = None;
    let mut id = None;

    for line in contents.lines() {
        if let Some(value) = line.strip_prefix("PRETTY_NAME=") {
            pretty_name = Some(strip_wrapping_quotes(value));
        } else if let Some(value) = line.strip_prefix("NAME=") {
            name = Some(strip_wrapping_quotes(value));
        } else if let Some(value) = line.strip_prefix("VERSION=") {
            version = Some(strip_wrapping_quotes(value));
        } else if let Some(value) = line.strip_prefix("ID=") {
            id = Some(strip_wrapping_quotes(value));
        }
    }

    pretty_name.or_else(|| match (name, version, id) {
        (Some(name), Some(version), Some(id)) => Some(format!("{name} {version} ({id})")),
        (Some(name), Some(version), None) => Some(format!("{name} {version}")),
        (Some(name), None, Some(id)) => Some(format!("{name} ({id})")),
        (Some(name), None, None) => Some(name),
        _ => None,
    })
}

fn terminal_execution_shell_description() -> String {
    if cfg!(target_os = "windows") {
        "Windows PowerShell (powershell.exe). Terminal tool commands run in PowerShell, not cmd.exe. Prefer PowerShell syntax such as Set-Location, semicolons or new lines for sequential steps, New-Item, Get-ChildItem, and [Environment]::GetFolderPath('Desktop'). Do not use cmd.exe-only separators like &&, ||, or cd /d.".to_string()
    } else {
        "bash".to_string()
    }
}

pub(crate) fn build_runtime_environment_prompt(
    app: &AppHandle,
    skills: &[SkillDefinition],
) -> String {
    let os = env::consts::OS;
    let arch = env::consts::ARCH;
    let current_dir = env::current_dir()
        .ok()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| "(unknown)".to_string());
    let shell = read_env_var("SHELL")
        .or_else(|| read_env_var("ComSpec"))
        .unwrap_or_else(|| "(unknown)".to_string());
    let linux_distribution =
        detect_linux_distribution().unwrap_or_else(|| "(not available)".to_string());
    let terminal_execution_shell = terminal_execution_shell_description();
    let custom_system_prompt = read_custom_system_prompt(app).unwrap_or_default();
    let prompt_skills = build_prompt_skill_section(skills);
    let tool_skills = build_tool_skill_section(skills);
    let custom_system_prompt_section = if custom_system_prompt.trim().is_empty() {
        String::new()
    } else {
        format!(
            "\n\nCustom system prompt from user settings:\n{}",
            custom_system_prompt
        )
    };

    format!(
        "{base_system_prompt}{custom_system_prompt_section}\n\nRuntime environment:\n- Operating system: {os}\n- CPU architecture: {arch}\n- Linux distribution: {linux_distribution}\n- Current working directory: {current_dir}\n- Default shell: {shell}\n- Terminal execution shell for execute_terminal_command: {terminal_execution_shell}\n- Note: If the environment looks like UOS, Kylin, Tongxin, or another domestic Linux distribution, prefer that platform's filesystem layout, package manager, and shell conventions.\n\nLoaded prompt skills:\n{prompt_skills}\n\nLoaded tool skills:\n{tool_skills}",
        base_system_prompt = TOOL_AGNOSTIC_SYSTEM_PROMPT,
        custom_system_prompt_section = custom_system_prompt_section,
    )
}

fn supported_env_keys() -> Vec<String> {
    MANAGED_ENV_KEYS
        .iter()
        .map(|name| (*name).to_string())
        .collect()
}

fn default_env_path() -> Option<PathBuf> {
    app_data_dir().map(|dir| dir.join(".env"))
}

fn default_env_example_path() -> Option<PathBuf> {
    app_data_dir().map(|dir| dir.join(".env.example"))
}

fn backend_env_path_candidates() -> Vec<PathBuf> {
    config_root_candidates()
        .into_iter()
        .map(|root| root.join(".env"))
        .collect()
}

fn active_backend_env_path() -> Option<PathBuf> {
    backend_env_path_candidates()
        .into_iter()
        .find(|candidate| candidate.exists())
}

fn capture_original_managed_env() -> &'static HashMap<String, Option<String>> {
    ORIGINAL_MANAGED_ENV.get_or_init(|| {
        MANAGED_ENV_KEYS
            .iter()
            .map(|name| ((*name).to_string(), env::var(name).ok()))
            .collect()
    })
}

fn restore_original_managed_env() {
    let snapshot = capture_original_managed_env();

    for name in MANAGED_ENV_KEYS {
        match snapshot.get(*name).cloned().flatten() {
            Some(value) => env::set_var(name, value),
            None => env::remove_var(name),
        }
    }
}

fn parse_env_entries_from_reader(
    reader: impl std::io::Read,
) -> Result<Vec<(String, String)>, String> {
    dotenvy::from_read_iter(reader)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to parse .env content: {error}"))
}

fn parse_env_entries_from_path(path: &Path) -> Result<Vec<(String, String)>, String> {
    dotenvy::from_path_iter(path)
        .map_err(|error| format!("Failed to read .env file from {}: {error}", path.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to parse .env file from {}: {error}", path.display()))
}

fn apply_env_entries(entries: &[(String, String)]) {
    let _guard = ENV_RELOAD_LOCK
        .lock()
        .expect("backend env reload lock poisoned");

    restore_original_managed_env();

    for (name, value) in entries {
        env::set_var(name, value);
    }
}

fn reload_backend_env_from_disk() -> Result<Option<PathBuf>, String> {
    capture_original_managed_env();

    if let Some(path) = active_backend_env_path() {
        let entries = parse_env_entries_from_path(&path)?;
        apply_env_entries(&entries);
        Ok(Some(path))
    } else {
        apply_env_entries(&[]);
        Ok(None)
    }
}

fn normalize_env_contents(contents: &str) -> String {
    let normalized = contents.replace("\r\n", "\n");

    if normalized.ends_with('\n') {
        normalized
    } else {
        format!("{normalized}\n")
    }
}

fn env_file_message(path: Option<&Path>) -> String {
    match path {
        Some(path) => format!("Backend .env is loaded from {}.", path.display()),
        None => "No backend .env file is installed. The app is using process environment variables only."
            .to_string(),
    }
}

pub(crate) fn load_backend_env_once() {
    ENV_LOADED.call_once(|| {
        let candidates = backend_env_path_candidates();

        match reload_backend_env_from_disk() {
            Ok(Some(path)) => log_info(format!("Loaded .env from {}", path.display())),
            Ok(None) => {
                let searched = candidates
                    .iter()
                    .map(|candidate| candidate.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ");
                log_info(format!(
                    "No .env file loaded; searched: {searched}. Continuing with process environment variables only."
                ));
            }
            Err(error) => {
                let searched = candidates
                    .iter()
                    .map(|candidate| candidate.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ");
                log_error(format!(
                    "Failed to reload backend .env; searched: {searched}. Continuing with process environment variables only: {error}"
                ));
            }
        }
    });
}

pub(crate) fn ensure_env_example_in_app_data() -> Result<(), String> {
    let Some(app_data_dir) = app_data_dir() else {
        return Ok(());
    };

    fs::create_dir_all(&app_data_dir).map_err(|error| {
        format!("Failed to create app data directory for env template: {error}")
    })?;

    let target_path = app_data_dir.join(".env.example");
    if target_path.exists() {
        return Ok(());
    }

    let source_path = config_root_candidates()
        .into_iter()
        .map(|root| root.join(".env.example"))
        .find(|candidate| candidate.exists() && candidate != &target_path);

    let Some(source_path) = source_path else {
        return Ok(());
    };

    let contents = fs::read(&source_path).map_err(|error| {
        format!(
            "Failed to read bundled env template, path={}, error={error}",
            source_path.display()
        )
    })?;
    fs::write(&target_path, contents).map_err(|error| {
        format!(
            "Failed to write env template, path={}, error={error}",
            target_path.display()
        )
    })?;

    log_info(format!(
        "Copied env template to app data directory, source={}, target={}",
        source_path.display(),
        target_path.display()
    ));

    Ok(())
}

pub(crate) fn get_backend_env_status() -> Result<BackendEnvStatus, String> {
    load_backend_env_once();

    let app_data_dir = default_env_path()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .or_else(app_data_dir)
        .ok_or_else(|| "Failed to resolve app data directory for backend env.".to_string())?;
    let env_file_path = default_env_path().unwrap_or_else(|| app_data_dir.join(".env"));
    let env_example_path =
        default_env_example_path().unwrap_or_else(|| app_data_dir.join(".env.example"));
    let env_example_contents = fs::read_to_string(&env_example_path).unwrap_or_default();
    let active_path = active_backend_env_path();

    Ok(BackendEnvStatus {
        env_file_exists: env_file_path.exists(),
        app_data_dir: app_data_dir.display().to_string(),
        env_file_path: env_file_path.display().to_string(),
        env_example_path: env_example_path.display().to_string(),
        env_example_contents,
        supported_keys: supported_env_keys(),
        message: env_file_message(active_path.as_deref()),
        mode_statuses: BackendModeStatuses {
            online: provider_status(AgentMode::Online),
            local: provider_status(AgentMode::Local),
        },
    })
}

pub(crate) fn import_backend_env(
    request: ImportBackendEnvRequest,
) -> Result<ImportBackendEnvResult, String> {
    let _ = &request.file_name;
    let trimmed = request.contents.trim();
    if trimmed.is_empty() {
        return Err("Backend .env file content cannot be empty.".to_string());
    }

    let normalized_contents = normalize_env_contents(trimmed);
    let entries = parse_env_entries_from_reader(Cursor::new(normalized_contents.as_bytes()))?;
    let imported_key_set = entries
        .iter()
        .map(|(name, _)| name.clone())
        .collect::<HashSet<_>>();
    let supported_key_set = MANAGED_ENV_KEYS
        .iter()
        .map(|name| (*name).to_string())
        .collect::<HashSet<_>>();

    if imported_key_set.is_disjoint(&supported_key_set) {
        return Err(format!(
            "Imported .env does not contain any supported keys. Supported keys: {}",
            supported_env_keys().join(", ")
        ));
    }

    let env_file_path = default_env_path()
        .ok_or_else(|| "Failed to resolve target path for backend .env.".to_string())?;
    if let Some(parent) = env_file_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create backend env directory: {error}"))?;
    }

    fs::write(&env_file_path, normalized_contents.as_bytes())
        .map_err(|error| format!("Failed to write backend .env file: {error}"))?;
    apply_env_entries(&entries);

    log_info(format!(
        "Imported backend .env file to {}, keys={}",
        env_file_path.display(),
        entries
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    ));

    Ok(ImportBackendEnvResult {
        imported: true,
        status: get_backend_env_status()?,
    })
}

pub(crate) fn read_env_var(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn read_online_api_key() -> Option<String> {
    read_env_var("ALIYUN_API_KEY").or_else(|| read_env_var("OPENAI_API_KEY"))
}

pub(crate) fn online_uses_aliyun_fallback() -> bool {
    read_env_var("OPENAI_BASE_URL").is_none() || read_env_var("OPENAI_MODEL").is_none()
}

pub(crate) fn read_env_or_default(name: &str, default_value: &str) -> String {
    read_env_var(name).unwrap_or_else(|| default_value.to_string())
}

pub(crate) fn load_aliyun_fallback_config(model: &str) -> Result<ProviderConfig, String> {
    load_backend_env_once();
    let api_key = read_online_api_key().ok_or_else(|| {
        "Online mode needs to fall back to Alibaba Cloud DashScope, but ALIYUN_API_KEY or OPENAI_API_KEY is missing."
            .to_string()
    })?;

    log_info(format!(
        "Online mode is using Alibaba Cloud DashScope fallback: base_url={}, model={}, api_key={}",
        ALIYUN_DASHSCOPE_BASE_URL,
        model,
        redact_secret(&api_key)
    ));

    Ok(ProviderConfig {
        base_url: ALIYUN_DASHSCOPE_BASE_URL.to_string(),
        model: model.to_string(),
        api_key,
    })
}

pub(crate) fn provider_status(mode: AgentMode) -> BackendModeStatus {
    load_backend_env_once();
    log_info(format!(
        "Checking backend provider status for {}",
        mode.label()
    ));

    if matches!(mode, AgentMode::Online) && online_uses_aliyun_fallback() {
        return if read_online_api_key().is_some() {
            log_info(
                "OpenAI online config is incomplete; falling back to Alibaba Cloud DashScope.",
            );
            BackendModeStatus {
                mode,
                configured: true,
                message: format!(
                    "{} is using Alibaba Cloud DashScope fallback at {} with model {} because OPENAI_BASE_URL or OPENAI_MODEL is missing.",
                    mode.label(),
                    ALIYUN_DASHSCOPE_BASE_URL,
                    read_env_or_default("ALIYUN_MODEL", ALIYUN_DASHSCOPE_MODEL)
                ),
            }
        } else {
            log_error(
                "OpenAI online config is incomplete and no ALIYUN_API_KEY / OPENAI_API_KEY is available for fallback.",
            );
            BackendModeStatus {
                mode,
                configured: false,
                message:
                    "OpenAI online config is incomplete, and fallback to Alibaba Cloud DashScope cannot be used because ALIYUN_API_KEY or OPENAI_API_KEY is missing."
                        .to_string(),
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
            message: format!(
                "{} is fully configured from backend environment variables.",
                mode.label()
            ),
        }
    } else {
        BackendModeStatus {
            mode,
            configured: false,
            message: format!(
                "{} is missing required environment variables: {}",
                mode.label(),
                missing.join(", ")
            ),
        }
    }
}

pub(crate) fn load_provider_config(mode: AgentMode) -> Result<ProviderConfig, String> {
    load_backend_env_once();
    log_info(format!("Loading provider config for {}", mode.label()));

    if matches!(mode, AgentMode::Online) && online_uses_aliyun_fallback() {
        let model = read_env_or_default("ALIYUN_MODEL", ALIYUN_DASHSCOPE_MODEL);
        return load_aliyun_fallback_config(&model);
    }

    let env_names = mode.env_names();
    let base_url = read_env_var(env_names.base_url)
        .ok_or_else(|| format!("Missing environment variable {}", env_names.base_url))?;
    let model = read_env_var(env_names.model)
        .ok_or_else(|| format!("Missing environment variable {}", env_names.model))?;
    let api_key = env_names.api_key.and_then(read_env_var).unwrap_or_default();

    if mode.api_key_required() && api_key.is_empty() {
        log_error(format!(
            "{} is missing API key env {}.",
            mode.label(),
            env_names.api_key.unwrap_or("API_KEY")
        ));
        return Err(format!(
            "{} is missing API key environment variable {}",
            mode.label(),
            env_names.api_key.unwrap_or("API_KEY")
        ));
    }

    log_info(format!(
        "{} config loaded: base_url={}, model={}, api_key={}",
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

pub(crate) fn load_provider_config_with_model_override(
    mode: AgentMode,
    model_override_env: Option<&str>,
) -> Result<ProviderConfig, String> {
    let mut config = load_provider_config(mode)?;

    if let Some(env_name) = model_override_env {
        if let Some(model) = read_env_var(env_name) {
            config.model = model;
        }
    }

    Ok(config)
}
