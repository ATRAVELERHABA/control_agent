//! 存放后端跨模块共享的静态常量。

/// 前后端用于流式事件通信的事件名称。
pub(crate) const STREAM_EVENT_NAME: &str = "agent-stream";

/// 项目根目录下用于存放技能声明的目录名称。
pub(crate) const SKILLS_DIR_NAME: &str = ".skills";

/// DuckDuckGo 搜索脚本相对于项目根目录的路径。
pub(crate) const DUCKDUCKGO_SEARCH_SCRIPT_RELATIVE_PATH: &str =
    "control_agent/scripts/duckduckgo_search_tool.py";

/// 本地音频转写脚本相对于项目根目录的路径。
pub(crate) const AUDIO_TRANSCRIBE_SCRIPT_RELATIVE_PATH: &str =
    "control_agent/scripts/audio_transcribe_tool.py";

/// 终端命令工具在模型侧暴露的固定名称。
pub(crate) const TOOL_NAME: &str = "execute_terminal_command";

/// 阿里云 DashScope 兼容接口的默认基地址。
pub(crate) const ALIYUN_DASHSCOPE_BASE_URL: &str =
    "https://dashscope.aliyuncs.com/compatible-mode/v1";

/// 阿里云 DashScope 的默认模型名称。
pub(crate) const ALIYUN_DASHSCOPE_MODEL: &str = "qwen3-max";

/// 阿里云 DashScope 默认视觉模型。
pub(crate) const ALIYUN_DASHSCOPE_VISION_MODEL: &str = "qwen3.6-plus";

/// 阿里云 DashScope 默认音频识别模型。
pub(crate) const ALIYUN_DASHSCOPE_AUDIO_MODEL: &str = "qwen3-asr-flash";

/// DuckDuckGo 搜索默认返回条数。
pub(crate) const DEFAULT_SEARCH_RESULT_LIMIT: u8 = 5;

/// DuckDuckGo 搜索允许的最大返回条数。
pub(crate) const MAX_SEARCH_RESULT_LIMIT: u8 = 10;

/// 通用工具模式下的系统提示词。
pub(crate) const TOOL_AGNOSTIC_SYSTEM_PROMPT: &str = "你是 AI-Universal-Assistant，运行在桌面端系统助手中。你可以在有必要时调用当前已加载的工具，但只有在确实需要联网搜索、环境验证、系统操作或读取外部结果时才调用。不要编造未实际调用过的工具结果。收到工具输出后，请基于真实结果继续分析，直到给出清晰的最终答复。对于需要用户确认的工具，必须等待确认后再继续。除非用户明确要求，否则不要执行明显具有破坏性的系统操作。";
