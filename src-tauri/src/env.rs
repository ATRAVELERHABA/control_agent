//! 负责环境变量加载、运行环境识别和模型配置构建。

use std::{env, fs, sync::Once};

use crate::{
    constants::{ALIYUN_DASHSCOPE_BASE_URL, ALIYUN_DASHSCOPE_MODEL, TOOL_AGNOSTIC_SYSTEM_PROMPT},
    logging::{log_error, log_info, redact_secret},
    models::{AgentMode, BackendModeStatus, ProviderConfig, SkillDefinition},
    skills::{build_prompt_skill_section, build_tool_skill_section},
};

/// 确保 `.env` 只被加载一次。
static ENV_LOADED: Once = Once::new();

/// 去掉 `/etc/os-release` 中双引号包裹的值。
fn strip_wrapping_quotes(value: &str) -> String {
    value.trim_matches('"').to_string()
}

/// 在 Linux 环境下识别发行版名称。
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

/// 构建注入给模型的系统提示词，包含运行环境与技能信息。
pub(crate) fn build_runtime_environment_prompt(skills: &[SkillDefinition]) -> String {
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
    let prompt_skills = build_prompt_skill_section(skills);
    let tool_skills = build_tool_skill_section(skills);

    format!(
        "{base_system_prompt}\n\n当前环境信息：\n- 操作系统内核: {os}\n- CPU 架构: {arch}\n- Linux 发行版: {linux_distribution}\n- 当前工作目录: {current_dir}\n- 默认 Shell: {shell}\n- 说明: 如果识别到 UOS / 麒麟 / 其他国产 Linux 发行版，请优先按对应发行版习惯理解命令和系统路径。\n\n已加载的提示型技能：\n{prompt_skills}\n\n已加载的工具型技能：\n{tool_skills}",
        base_system_prompt = TOOL_AGNOSTIC_SYSTEM_PROMPT,
    )
}

/// 仅在应用启动时加载一次 `.env` 文件。
pub(crate) fn load_backend_env_once() {
    ENV_LOADED.call_once(|| match dotenvy::dotenv() {
        Ok(path) => log_info(format!("已加载 .env 文件：{}", path.display())),
        Err(error) => log_info(format!(
            "未加载到 .env 文件，将继续使用系统环境变量：{error}"
        )),
    });
}

/// 读取并裁剪单个环境变量。
pub(crate) fn read_env_var(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// 在线模式优先读取阿里云 Key，缺失时再回退到 OpenAI Key。
fn read_online_api_key() -> Option<String> {
    read_env_var("ALIYUN_API_KEY").or_else(|| read_env_var("OPENAI_API_KEY"))
}

/// 判断在线模式是否需要自动回退到阿里云模型。
pub(crate) fn online_uses_aliyun_fallback() -> bool {
    read_env_var("OPENAI_BASE_URL").is_none() || read_env_var("OPENAI_MODEL").is_none()
}

/// 读取环境变量或返回默认值。
pub(crate) fn read_env_or_default(name: &str, default_value: &str) -> String {
    read_env_var(name).unwrap_or_else(|| default_value.to_string())
}

/// 加载阿里云 DashScope 回退配置，并允许覆盖模型名。
pub(crate) fn load_aliyun_fallback_config(model: &str) -> Result<ProviderConfig, String> {
    load_backend_env_once();
    let api_key = read_online_api_key().ok_or_else(|| {
        "在线模式将回退到阿里云 DashScope，但缺少 API Key：ALIYUN_API_KEY 或 OPENAI_API_KEY。"
            .to_string()
    })?;

    log_info(format!(
        "在线模式使用阿里云 DashScope 回退配置：base_url={}, model={}, api_key={}",
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

/// 检查某个模式当前是否完成了运行所需配置。
pub(crate) fn provider_status(mode: AgentMode) -> BackendModeStatus {
    load_backend_env_once();
    log_info(format!("检查后端模式配置状态：{}", mode.label()));

    if matches!(mode, AgentMode::Online) && online_uses_aliyun_fallback() {
        return if read_online_api_key().is_some() {
            log_info("在线模式未检测到完整 OpenAI 配置，将回退到阿里云 DashScope。");
            BackendModeStatus {
                mode,
                configured: true,
                message: format!(
                    "{}未检测到完整的 OpenAI 在线模型配置，已自动回退到阿里云 DashScope（{}，模型 {}）。",
                    mode.label(),
                    ALIYUN_DASHSCOPE_BASE_URL,
                    read_env_or_default("ALIYUN_MODEL", ALIYUN_DASHSCOPE_MODEL)
                ),
            }
        } else {
            log_error(
                "在线模式未检测到完整 OpenAI 配置，且未找到 ALIYUN_API_KEY / OPENAI_API_KEY。",
            );
            BackendModeStatus {
                mode,
                configured: false,
                message:
                    "在线模式未检测到完整 OpenAI 配置，将回退到阿里云 DashScope，但缺少 API Key：ALIYUN_API_KEY 或 OPENAI_API_KEY。"
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
            message: format!("{}已从后端环境变量加载完成。", mode.label()),
        }
    } else {
        BackendModeStatus {
            mode,
            configured: false,
            message: format!(
                "{}未配置完成，缺少环境变量：{}",
                mode.label(),
                missing.join(", ")
            ),
        }
    }
}

/// 按运行模式加载模型配置，并处理在线模式的回退逻辑。
pub(crate) fn load_provider_config(mode: AgentMode) -> Result<ProviderConfig, String> {
    load_backend_env_once();
    log_info(format!("开始加载{}配置。", mode.label()));

    if matches!(mode, AgentMode::Online) && online_uses_aliyun_fallback() {
        let model = read_env_or_default("ALIYUN_MODEL", ALIYUN_DASHSCOPE_MODEL);
        return load_aliyun_fallback_config(&model);
    }

    let env_names = mode.env_names();
    let base_url = read_env_var(env_names.base_url)
        .ok_or_else(|| format!("缺少环境变量 {}", env_names.base_url))?;
    let model =
        read_env_var(env_names.model).ok_or_else(|| format!("缺少环境变量 {}", env_names.model))?;
    let api_key = env_names.api_key.and_then(read_env_var).unwrap_or_default();

    if mode.api_key_required() && api_key.is_empty() {
        log_error(format!(
            "{}缺少 API Key，期望环境变量 {}。",
            mode.label(),
            env_names.api_key.unwrap_or("API_KEY")
        ));
        return Err(format!(
            "{}缺少 API Key 环境变量 {}",
            mode.label(),
            env_names.api_key.unwrap_or("API_KEY")
        ));
    }

    log_info(format!(
        "{}配置已加载：base_url={}, model={}, api_key={}",
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

/// 在基础模型配置之上允许按场景覆盖模型名。
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
