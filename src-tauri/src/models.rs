//! 定义后端跨模块共享的数据模型、请求体与事件结构。

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::constants::{DEFAULT_SEARCH_RESULT_LIMIT, MAX_SEARCH_RESULT_LIMIT};

/// 表示技能在运行时的分类。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum SkillType {
    /// 提示型技能会被注入到系统提示词中。
    Prompt,
    /// 工具型技能会暴露给模型作为 function calling 工具。
    Tool,
}

/// 描述单个技能在磁盘上的完整定义。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct SkillDefinition {
    /// 技能的稳定唯一标识。
    pub(crate) id: String,
    /// 技能的展示名称。
    pub(crate) name: String,
    /// 技能的简短描述。
    pub(crate) description: String,
    /// 技能的类型，用于决定注入方式。
    #[serde(rename = "type")]
    pub(crate) skill_type: SkillType,
    /// 技能是否启用。
    #[serde(default = "default_true")]
    pub(crate) enabled: bool,
    /// 提示型技能的附加指令。
    #[serde(default)]
    pub(crate) instruction: Option<String>,
    /// 工具型技能的工具定义。
    #[serde(default)]
    pub(crate) tool: Option<ToolSkillDefinition>,
}

/// 描述工具型技能暴露给模型的函数定义。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ToolSkillDefinition {
    /// 工具在模型侧的函数名。
    pub(crate) name: String,
    /// 工具的用途描述。
    pub(crate) description: String,
    /// 工具参数的 JSON Schema。
    pub(crate) parameters: Value,
    /// 工具是否需要用户确认。
    #[serde(default)]
    pub(crate) requires_confirmation: bool,
}

/// 技能开关的默认值，未配置时视为启用。
fn default_true() -> bool {
    true
}

/// DuckDuckGo 搜索结果数量的默认值。
fn default_search_result_limit() -> u8 {
    DEFAULT_SEARCH_RESULT_LIMIT
}

/// 将用户传入的搜索结果条数约束在安全范围内。
pub(crate) fn clamp_search_result_limit(value: u8) -> u8 {
    value.clamp(1, MAX_SEARCH_RESULT_LIMIT)
}

/// 供前端技能列表展示使用的技能摘要。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillSummary {
    /// 技能唯一标识。
    pub(crate) id: String,
    /// 技能显示名称。
    pub(crate) name: String,
    /// 技能描述。
    pub(crate) description: String,
    /// 技能类型。
    pub(crate) skill_type: SkillType,
    /// 当前是否启用。
    pub(crate) enabled: bool,
    /// 当前技能是否需要确认。
    pub(crate) requires_confirmation: bool,
}

/// 表示后端当前使用的模型模式。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum AgentMode {
    /// 在线模式，走 OpenAI 兼容接口。
    Online,
    /// 本地模式，走 Ollama 的 OpenAI 兼容接口。
    Local,
}

impl AgentMode {
    /// 返回当前模式在前端展示时使用的中文标签。
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Online => "在线模式",
            Self::Local => "本地模式",
        }
    }

    /// 返回当前模式所需的环境变量名称集合。
    pub(crate) fn env_names(self) -> ProviderEnvNames {
        match self {
            Self::Online => ProviderEnvNames {
                base_url: "OPENAI_BASE_URL",
                model: "OPENAI_MODEL",
                api_key: Some("OPENAI_API_KEY"),
            },
            Self::Local => ProviderEnvNames {
                base_url: "OLLAMA_BASE_URL",
                model: "OLLAMA_MODEL",
                api_key: Some("OLLAMA_API_KEY"),
            },
        }
    }

    /// 判断当前模式是否必须提供 API Key。
    pub(crate) fn api_key_required(self) -> bool {
        matches!(self, Self::Online)
    }
}

/// 描述某种模型模式依赖的环境变量名称。
#[derive(Debug, Clone, Copy)]
pub(crate) struct ProviderEnvNames {
    /// 基础 URL 对应的环境变量名。
    pub(crate) base_url: &'static str,
    /// 模型名对应的环境变量名。
    pub(crate) model: &'static str,
    /// API Key 对应的环境变量名。
    pub(crate) api_key: Option<&'static str>,
}

/// 表示后端最终加载出的模型配置。
#[derive(Debug, Clone)]
pub(crate) struct ProviderConfig {
    /// 模型接口基地址。
    pub(crate) base_url: String,
    /// 模型名称。
    pub(crate) model: String,
    /// 调用模型时使用的 API Key。
    pub(crate) api_key: String,
}

/// 表示某一种模式的可用性检查结果。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackendModeStatus {
    /// 当前状态对应的模式。
    pub(crate) mode: AgentMode,
    /// 是否已经完成配置。
    pub(crate) configured: bool,
    /// 对用户展示的状态说明。
    pub(crate) message: String,
}

/// 聚合两种模式的后端状态。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackendModeStatuses {
    /// 在线模式状态。
    pub(crate) online: BackendModeStatus,
    /// 本地模式状态。
    pub(crate) local: BackendModeStatus,
}

/// 单轮代理执行请求。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentTurnRequest {
    /// 当前选中的代理模式。
    pub(crate) mode: AgentMode,
    /// 本轮流式对话的唯一标识。
    pub(crate) stream_id: String,
    /// 当前累计对话消息。
    pub(crate) messages: Vec<ConversationMessageDto>,
}

/// 执行终端命令时的请求参数。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunCommandRequest {
    /// 需要执行的完整命令字符串。
    pub(crate) command: String,
    /// 所属流式会话标识。
    #[serde(default)]
    pub(crate) stream_id: Option<String>,
    /// 前端用于关联命令输出的消息标识。
    #[serde(default)]
    pub(crate) command_id: Option<String>,
}

/// 执行 DuckDuckGo 搜索时的请求参数。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunDuckDuckGoSearchRequest {
    /// 搜索关键字。
    pub(crate) query: String,
    /// 期望返回的结果条数。
    #[serde(default = "default_search_result_limit")]
    pub(crate) max_results: u8,
}

/// 表示用户上传或粘贴进对话的附件类型。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum AssetKind {
    /// 图像类资源。
    Image,
    /// 音频类资源。
    Audio,
}

/// 前端注册附件时传给后端的请求结构。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RegisterAssetRequest {
    /// 原始文件名。
    pub(crate) file_name: String,
    /// MIME 类型。
    pub(crate) mime_type: String,
    /// 文件字节内容。
    pub(crate) bytes: Vec<u8>,
}

/// 返回给前端和模型上下文的附件摘要。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AssetSummary {
    /// 后端分配的资源 ID。
    pub(crate) asset_id: String,
    /// 资源类型。
    pub(crate) kind: AssetKind,
    /// 展示文件名。
    pub(crate) display_name: String,
    /// MIME 类型。
    pub(crate) mime_type: String,
    /// 文件大小。
    pub(crate) size_bytes: u64,
}

/// 图像分析工具执行请求。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnalyzeImageRequest {
    /// 当前运行模式。
    pub(crate) mode: AgentMode,
    /// 目标附件 ID。
    pub(crate) asset_id: String,
    /// 用户或模型指定的分析任务。
    #[serde(default)]
    pub(crate) task: Option<String>,
    /// 是否强化 OCR 输出。
    #[serde(default)]
    pub(crate) ocr: Option<bool>,
}

/// 音频转写工具执行请求。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranscribeAudioRequest {
    /// 当前运行模式。
    pub(crate) mode: AgentMode,
    /// 目标附件 ID。
    pub(crate) asset_id: String,
    /// 可选语言提示。
    #[serde(default)]
    pub(crate) language: Option<String>,
    /// 可选转写提示词。
    #[serde(default)]
    pub(crate) prompt: Option<String>,
}

/// 更新技能启用状态时的请求参数。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateSkillEnabledRequest {
    /// 目标技能的唯一标识。
    pub(crate) skill_id: String,
    /// 目标技能的新启用状态。
    pub(crate) enabled: bool,
}

/// 单轮代理执行完成后返回给前端的新消息集合。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentTurnResult {
    /// 本轮新增的对话消息。
    pub(crate) new_messages: Vec<ConversationMessageDto>,
}

/// 统一描述前后端之间传递的对话消息。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversationMessageDto {
    /// 消息角色，例如 user、assistant、tool。
    pub(crate) role: String,
    /// 消息文本内容。
    pub(crate) content: Option<String>,
    /// 工具消息对应的 tool_call_id。
    #[serde(default)]
    pub(crate) tool_call_id: Option<String>,
    /// assistant 消息中附带的工具调用列表。
    #[serde(default)]
    pub(crate) tool_calls: Option<Vec<ToolCallDto>>,
}

/// 完整的工具调用信息。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolCallDto {
    /// 工具调用唯一标识。
    pub(crate) id: String,
    /// 工具调用类型，当前固定为 function。
    #[serde(rename = "type")]
    pub(crate) tool_type: String,
    /// 具体函数调用信息。
    pub(crate) function: ToolFunctionDto,
}

/// 单个 function calling 项的函数明细。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolFunctionDto {
    /// 函数名。
    pub(crate) name: String,
    /// JSON 字符串形式的参数。
    pub(crate) arguments: String,
}

/// 模型流式输出结束后的聚合结果。
#[derive(Debug, Default)]
pub(crate) struct StreamCompletionResult {
    /// 最终聚合出的正文文本。
    pub(crate) content: String,
    /// 最终聚合出的工具调用列表。
    pub(crate) tool_calls: Vec<ToolCallDto>,
}

/// 单个流式分片的外层结构。
#[derive(Debug, Deserialize)]
pub(crate) struct ChatCompletionChunk {
    /// 当前分片包含的选择项列表。
    pub(crate) choices: Vec<ChatCompletionChoiceChunk>,
}

/// 单个流式选择项结构。
#[derive(Debug, Deserialize)]
pub(crate) struct ChatCompletionChoiceChunk {
    /// 当前选择项的增量内容。
    pub(crate) delta: ChatCompletionDelta,
}

/// 流式返回中的 delta 部分。
#[derive(Debug, Default, Deserialize)]
pub(crate) struct ChatCompletionDelta {
    /// assistant 文本增量。
    pub(crate) content: Option<String>,
    /// 工具调用增量。
    pub(crate) tool_calls: Option<Vec<ToolCallChunk>>,
}

/// 工具调用的分片结构。
#[derive(Debug, Deserialize)]
pub(crate) struct ToolCallChunk {
    /// 工具在当前响应数组中的索引。
    pub(crate) index: Option<usize>,
    /// 工具调用唯一标识的分片。
    pub(crate) id: Option<String>,
    /// 工具类型的分片。
    #[serde(rename = "type")]
    pub(crate) tool_type: Option<String>,
    /// 函数内容的分片。
    pub(crate) function: Option<ToolFunctionChunk>,
}

/// 工具函数分片结构。
#[derive(Debug, Default, Deserialize)]
pub(crate) struct ToolFunctionChunk {
    /// 函数名分片。
    pub(crate) name: Option<String>,
    /// 函数参数分片。
    pub(crate) arguments: Option<String>,
}

/// 后端发送给前端的流式事件。
#[derive(Debug, Serialize, Clone)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum AgentStreamEvent {
    /// 普通状态更新事件。
    Status { stream_id: String, message: String },
    /// assistant 开始输出事件。
    AssistantStart { stream_id: String },
    /// assistant 文本增量事件。
    AssistantDelta { stream_id: String, delta: String },
    /// assistant 输出完成事件。
    AssistantComplete {
        stream_id: String,
        content: String,
        has_tool_calls: bool,
    },
    /// 工具调用提示事件。
    ToolCall {
        stream_id: String,
        tool_name: String,
        command: String,
    },
    /// 命令输出行事件。
    CommandOutput {
        stream_id: String,
        command_id: String,
        stream_kind: String,
        line: String,
    },
    /// 命令执行完成事件。
    CommandComplete {
        stream_id: String,
        command_id: String,
        success: bool,
    },
}

/// 解析终端工具参数时使用的结构。
#[derive(Debug, Deserialize)]
pub(crate) struct ToolArguments {
    /// 终端命令正文。
    pub(crate) command: String,
}

/// DuckDuckGo 搜索脚本返回的原始负载。
#[derive(Debug, Deserialize)]
pub(crate) struct DuckDuckGoSearchPayload {
    /// 原始查询词。
    pub(crate) query: String,
    /// 搜索结果集合。
    pub(crate) results: Vec<DuckDuckGoSearchResult>,
}

/// 单条 DuckDuckGo 搜索结果。
#[derive(Debug, Deserialize)]
pub(crate) struct DuckDuckGoSearchResult {
    /// 搜索结果标题。
    pub(crate) title: String,
    /// 搜索结果链接。
    pub(crate) url: String,
    /// 搜索结果摘要。
    pub(crate) snippet: String,
}
