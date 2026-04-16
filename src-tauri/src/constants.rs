//! Shared backend constants.

pub(crate) const STREAM_EVENT_NAME: &str = "agent-stream";
pub(crate) const SKILLS_DIR_NAME: &str = ".skills";

pub(crate) const DUCKDUCKGO_SEARCH_SCRIPT_RELATIVE_PATH: &str =
    "control_agent/scripts/duckduckgo_search_tool.py";
pub(crate) const AUDIO_TRANSCRIBE_SCRIPT_RELATIVE_PATH: &str =
    "control_agent/scripts/audio_transcribe_tool.py";
pub(crate) const DINGTALK_STREAM_SCRIPT_RELATIVE_PATH: &str =
    "control_agent/scripts/dingtalk_stream_bot.py";

pub(crate) const TOOL_NAME: &str = "execute_terminal_command";

pub(crate) const LICENSE_PRODUCT_ID: &str = "com.aiuniversalassistant.app";
pub(crate) const LICENSE_SCHEMA_VERSION: u32 = 1;
pub(crate) const DEFAULT_LICENSE_PUBLIC_KEY: &str =
    "vZ-2JTrA6D0a5uFfmF74cNe0MBw4No8F_BIYe09GG_E";
pub(crate) const LICENSE_PUBLIC_KEY_ENV_NAME: &str = "LICENSE_PUBLIC_KEY";
pub(crate) const LICENSE_STATE_FILE_NAME: &str = "activation-state.json";
pub(crate) const LICENSE_COPY_FILE_NAME: &str = "license.json";
pub(crate) const AUTH_DIR_NAME: &str = "auth";
pub(crate) const ACCOUNT_STORE_FILE_NAME: &str = "accounts.json";
pub(crate) const SESSION_STATE_FILE_NAME: &str = "session.json";

pub(crate) const ALIYUN_DASHSCOPE_BASE_URL: &str =
    "https://dashscope.aliyuncs.com/compatible-mode/v1";
pub(crate) const ALIYUN_DASHSCOPE_MODEL: &str = "qwen3-max";
pub(crate) const ALIYUN_DASHSCOPE_VISION_MODEL: &str = "qwen3.6-plus";
pub(crate) const ALIYUN_DASHSCOPE_AUDIO_MODEL: &str = "qwen3-asr-flash";

pub(crate) const DEFAULT_SEARCH_RESULT_LIMIT: u8 = 5;
pub(crate) const MAX_SEARCH_RESULT_LIMIT: u8 = 10;

pub(crate) const TOOL_AGNOSTIC_SYSTEM_PROMPT: &str = "You are AI-Universal-Assistant, a desktop AI assistant running on the user's machine. You may use the currently loaded tools when they are genuinely needed for web search, environment verification, system operations, or reading external results. Never invent tool results. After receiving tool output, continue the analysis based on the real output until you can provide a clear final answer. If a tool requires user confirmation, wait for confirmation before proceeding. Unless the user explicitly asks for it, do not perform obviously destructive system actions.";
