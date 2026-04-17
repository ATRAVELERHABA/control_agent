// 前端类型与辅助函数文件。
// 这里不再直接请求模型，也不再读取前端环境变量。
// 当前职责只有：
// 1. 定义前后端交互使用的 TypeScript 类型
// 2. 定义 UI 里需要的模式标签与提示文案
// 3. 提供一些简单的客户端辅助函数

export type AgentMode = "online" | "local";
export const MAX_TOOL_CALL_ROUNDS = 10;
export type SkillType = "prompt" | "tool";

export interface ToolFunctionCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ConversationMessage {
  role: "user" | "assistant" | "tool";
  content: string | null;
  toolCallId?: string;
  toolCalls?: ToolFunctionCall[];
}

export interface RunAgentTurnRequest {
  mode: AgentMode;
  streamId: string;
  messages: ConversationMessage[];
}

export interface RunAgentTurnResult {
  newMessages: ConversationMessage[];
}

export interface RunCommandRequest {
  command: string;
  streamId?: string;
  commandId?: string;
}

export interface RunDuckDuckGoSearchRequest {
  query: string;
  maxResults?: number;
}

export type AssetKind = "image" | "audio";

export interface AssetSummary {
  assetId: string;
  kind: AssetKind;
  displayName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface RegisterAssetRequest {
  fileName: string;
  mimeType: string;
  bytes: number[];
}

export interface AnalyzeImageRequest {
  mode: AgentMode;
  assetId: string;
  task?: string;
  ocr?: boolean;
}

export interface TranscribeAudioRequest {
  mode: AgentMode;
  assetId: string;
  language?: string;
  prompt?: string;
}

export interface BackendModeStatus {
  mode: AgentMode;
  configured: boolean;
  message: string;
}

export interface BackendModeStatuses {
  online: BackendModeStatus;
  local: BackendModeStatus;
}

export interface LicenseStatus {
  valid: boolean;
  message: string;
  accountEmail?: string;
  licenseId?: string;
  issuedAt?: string;
  appDataDir: string;
}

export interface ImportLicenseRequest {
  fileName: string;
  contents: string;
}

export interface ImportLicenseResult {
  valid: boolean;
  status: LicenseStatus;
}

export interface SessionStatus {
  authenticated: boolean;
  message: string;
  email?: string;
}

export interface CurrentUser {
  email: string;
}

export interface DingTalkLogEntry {
  timestamp: string;
  level: string;
  message: string;
}

export interface DingTalkStatus {
  configured: boolean;
  running: boolean;
  mode: AgentMode;
  message: string;
  remoteCommandsEnabled: boolean;
  allowedSenderCount: number;
  allowedChatCount: number;
  events: DingTalkLogEntry[];
}

export interface RegisterAccountRequest {
  email: string;
  password: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  mode: AgentMode;
  createdAt: number;
  updatedAt: number;
  lastPreview: string;
  messageCount: number;
}

export interface CreateConversationRequest {
  mode: AgentMode;
  title?: string;
}

export interface ConversationMessagesRequest {
  conversationId: string;
}

export interface AppendConversationMessagesRequest {
  conversationId: string;
  messages: ConversationMessage[];
  mode?: AgentMode;
}

export interface DeleteConversationRequest {
  conversationId: string;
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  skillType: SkillType;
  enabled: boolean;
  requiresConfirmation: boolean;
}

export interface UpdateSkillRequiresConfirmationRequest {
  skillId: string;
  requiresConfirmation: boolean;
}

export interface SystemPromptSettings {
  customPrompt: string;
}

export interface UpdateSystemPromptSettingsRequest {
  customPrompt: string;
}

export type AgentStreamEvent =
  | {
      kind: "status";
      streamId: string;
      message: string;
    }
  | {
      kind: "assistant-start";
      streamId: string;
    }
  | {
      kind: "assistant-delta";
      streamId: string;
      delta: string;
    }
  | {
      kind: "assistant-complete";
      streamId: string;
      content: string;
      hasToolCalls: boolean;
    }
  | {
      kind: "tool-call";
      streamId: string;
      toolName: string;
      command: string;
    }
  | {
      kind: "tool-result";
      streamId: string;
      output: string;
      success: boolean;
    }
  | {
      kind: "command-output";
      streamId: string;
      commandId: string;
      streamKind: string;
      line: string;
    }
  | {
      kind: "command-complete";
      streamId: string;
      commandId: string;
      success: boolean;
    };

export const MODE_LABELS: Record<AgentMode, string> = {
  online: "在线模式",
  local: "本地模式",
};

export const MODE_DESCRIPTIONS: Record<AgentMode, string> = {
  online: "从后端环境变量读取 OPENAI_* 配置，请求在线兼容 OpenAI 的接口。",
  local: "从后端环境变量读取 OLLAMA_* 配置，请求本地 Ollama 的兼容 OpenAI 端点。",
};

export const STREAM_EVENT_NAME = "agent-stream";

export function createClientId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseToolArgumentsObject(argumentsText: string): Record<string, unknown> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(argumentsText);
  } catch (error) {
    throw new Error(
      `模型返回的工具参数不是合法 JSON：${formatUnknownError(error)}\n\n原始参数：${argumentsText}`,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("工具参数必须是 JSON object。");
  }

  return parsed as Record<string, unknown>;
}

export function parseExecuteTerminalCommandArguments(argumentsText: string): {
  command: string;
} {
  const parsed = parseToolArgumentsObject(argumentsText);

  if (typeof parsed.command !== "string") {
    throw new Error("工具参数中缺少有效的 command 字段。");
  }

  const command = parsed.command.trim();

  if (!command) {
    throw new Error("工具参数中的 command 不能为空。");
  }

  return { command };
}

export function parseDuckDuckGoSearchArguments(argumentsText: string): {
  query: string;
  maxResults: number;
} {
  const parsed = parseToolArgumentsObject(argumentsText);

  if (typeof parsed.query !== "string") {
    throw new Error("工具参数中缺少有效的 query 字段。");
  }

  const query = parsed.query.trim();

  if (!query) {
    throw new Error("工具参数中的 query 不能为空。");
  }

  const rawMaxResults =
    typeof parsed.maxResults === "number"
      ? parsed.maxResults
      : typeof parsed.max_results === "number"
        ? parsed.max_results
        : 5;

  if (!Number.isFinite(rawMaxResults)) {
    throw new Error("工具参数中的 maxResults 必须是数字。");
  }

  const maxResults = Math.min(10, Math.max(1, Math.trunc(rawMaxResults)));

  return { query, maxResults };
}

export function parseAnalyzeImageArguments(argumentsText: string): {
  assetId: string;
  task?: string;
  ocr: boolean;
} {
  const parsed = parseToolArgumentsObject(argumentsText);
  const rawAssetId =
    typeof parsed.assetId === "string"
      ? parsed.assetId
      : typeof parsed.asset_id === "string"
        ? parsed.asset_id
        : "";

  const assetId = rawAssetId.trim();

  if (!assetId) {
    throw new Error("工具参数中缺少有效的 assetId。");
  }

  const task =
    typeof parsed.task === "string" && parsed.task.trim()
      ? parsed.task.trim()
      : undefined;
  const ocr =
    typeof parsed.ocr === "boolean"
      ? parsed.ocr
      : typeof parsed.enableOcr === "boolean"
        ? parsed.enableOcr
        : typeof parsed.enable_ocr === "boolean"
          ? parsed.enable_ocr
          : false;

  return { assetId, task, ocr };
}

export function parseTranscribeAudioArguments(argumentsText: string): {
  assetId: string;
  language?: string;
  prompt?: string;
} {
  const parsed = parseToolArgumentsObject(argumentsText);
  const rawAssetId =
    typeof parsed.assetId === "string"
      ? parsed.assetId
      : typeof parsed.asset_id === "string"
        ? parsed.asset_id
        : "";

  const assetId = rawAssetId.trim();

  if (!assetId) {
    throw new Error("工具参数中缺少有效的 assetId。");
  }

  const language =
    typeof parsed.language === "string" && parsed.language.trim()
      ? parsed.language.trim()
      : undefined;
  const prompt =
    typeof parsed.prompt === "string" && parsed.prompt.trim()
      ? parsed.prompt.trim()
      : undefined;

  return { assetId, language, prompt };
}
