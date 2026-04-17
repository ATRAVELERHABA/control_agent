//! Backend environment loading and provider configuration helpers.

use std::{env, fs, sync::Once};

use tauri::AppHandle;

use crate::{
    constants::{ALIYUN_DASHSCOPE_BASE_URL, ALIYUN_DASHSCOPE_MODEL, TOOL_AGNOSTIC_SYSTEM_PROMPT},
    logging::{log_error, log_info, redact_secret},
    models::{AgentMode, BackendModeStatus, ProviderConfig, SkillDefinition},
    settings::read_custom_system_prompt,
    skills::{build_prompt_skill_section, build_tool_skill_section},
};

static ENV_LOADED: Once = Once::new();

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

pub(crate) fn load_backend_env_once() {
    ENV_LOADED.call_once(|| match dotenvy::dotenv() {
        Ok(path) => log_info(format!("Loaded .env from {}", path.display())),
        Err(error) => log_info(format!(
            "No .env file loaded; continuing with process environment variables only: {error}"
        )),
    });
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
