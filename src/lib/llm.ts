// 前端类型与辅助函数文件。
// 这里不再直接请求模型，也不再读取前端环境变量。
// 当前职责只有：
// 1. 定义前后端交互使用的 TypeScript 类型
// 2. 定义 UI 里需要的模式标签与提示文案
// 3. 提供一些简单的客户端辅助函数

export type AgentMode = "online" | "local";

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

export interface BackendModeStatus {
  mode: AgentMode;
  configured: boolean;
  message: string;
}

export interface BackendModeStatuses {
  online: BackendModeStatus;
  local: BackendModeStatus;
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
    };

export const MODE_LABELS: Record<AgentMode, string> = {
  online: "在线模式",
  local: "本地模式",
};

export const MODE_DESCRIPTIONS: Record<AgentMode, string> = {
  online: "从后端环境变量读取 OPENAI_* 配置，请求在线 OpenAI-compatible 接口。",
  local: "从后端环境变量读取 OLLAMA_* 配置，请求本地 Ollama 的 OpenAI-compatible 端点。",
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
