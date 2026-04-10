// 应用主界面组件。
// 这个版本使用接近“侧栏 + 主对话区 + 底部输入框”的布局模式：
// 1. 左侧是模式切换和状态指示
// 2. 中间是单独滚动的聊天区域
// 3. 底部输入框固定在聊天区底部，不随页面整体增长
import {
  AppstoreOutlined,
  ApiOutlined,
  CheckCircleFilled,
  DeleteOutlined,
  DesktopOutlined,
  FileTextOutlined,
  LoadingOutlined,
  MessageOutlined,
  PaperClipOutlined,
  RobotOutlined,
  SendOutlined,
  ThunderboltOutlined,
  WarningFilled,
} from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Alert,
  Badge,
  Button,
  ConfigProvider,
  Empty,
  Input,
  Layout,
  Modal,
  Segmented,
  Space,
  Spin,
  Switch,
  Tag,
  Typography,
} from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  MODE_DESCRIPTIONS,
  MODE_LABELS,
  MAX_TOOL_CALL_ROUNDS,
  STREAM_EVENT_NAME,
  createClientId,
  formatUnknownError,
  parseAnalyzeImageArguments,
  parseDuckDuckGoSearchArguments,
  parseExecuteTerminalCommandArguments,
  parseTranscribeAudioArguments,
  type AnalyzeImageRequest,
  type AgentMode,
  type AgentStreamEvent,
  type AssetKind,
  type AssetSummary,
  type BackendModeStatuses,
  type ConversationMessage,
  type RegisterAssetRequest,
  type RunCommandRequest,
  type RunDuckDuckGoSearchRequest,
  type RunAgentTurnRequest,
  type RunAgentTurnResult,
  type SkillSummary,
  type ToolFunctionCall,
  type TranscribeAudioRequest,
} from "./lib/llm";

const { Sider, Content } = Layout;
const { Title, Paragraph, Text } = Typography;
const { TextArea } = Input;

type UiMessageKind =
  | "user"
  | "assistant"
  | "tool-call"
  | "tool-result"
  | "error";

type UiMessageStatus = "streaming" | "completed" | "error";
type MainPanel = "chat" | "skills";

interface UiMessage {
  id: string;
  kind: UiMessageKind;
  title: string;
  content: string;
  status: UiMessageStatus;
  attachments?: MessageAttachment[];
}

interface PendingAttachment {
  id: string;
  file: File;
  kind: AssetKind;
  previewUrl?: string;
}

interface MessageAttachment {
  id: string;
  kind: AssetKind;
  displayName: string;
  mimeType: string;
  sizeBytes: number;
  previewUrl?: string;
  assetId?: string;
}

function readEventField<T>(
  payload: Record<string, unknown>,
  camelKey: string,
  snakeKey: string,
): T | undefined {
  if (camelKey in payload) {
    return payload[camelKey] as T;
  }

  if (snakeKey in payload) {
    return payload[snakeKey] as T;
  }

  return undefined;
}

function createUiMessage(
  kind: UiMessageKind,
  title: string,
  content: string,
  status: UiMessageStatus = "completed",
  attachments?: MessageAttachment[],
): UiMessage {
  return {
    id: createClientId(kind),
    kind,
    title,
    content,
    status,
    attachments,
  };
}

function getMessageTone(kind: UiMessageKind) {
  switch (kind) {
    case "user":
      return {
        wrapper: "justify-end",
        card: "border-sky-400/30 bg-sky-500/12",
        title: "text-sky-100",
      };
    case "assistant":
      return {
        wrapper: "justify-start",
        card: "border-white/10 bg-white/[0.03]",
        title: "text-slate-100",
      };
    case "tool-call":
      return {
        wrapper: "justify-start",
        card: "border-amber-400/20 bg-amber-500/10",
        title: "text-amber-100",
      };
    case "tool-result":
      return {
        wrapper: "justify-start",
        card: "border-violet-400/20 bg-violet-500/10",
        title: "text-violet-100",
      };
    case "error":
      return {
        wrapper: "justify-start",
        card: "border-rose-400/25 bg-rose-500/10",
        title: "text-rose-100",
      };
    default:
      return {
        wrapper: "justify-start",
        card: "border-white/10 bg-white/[0.03]",
        title: "text-slate-100",
      };
  }
}

function inferAssetKind(file: File): AssetKind | null {
  if (file.type.startsWith("image/")) {
    return "image";
  }

  if (file.type.startsWith("audio/")) {
    return "audio";
  }

  const loweredName = file.name.toLowerCase();
  if (/\.(png|jpe?g|gif|bmp|webp|svg|heic)$/.test(loweredName)) {
    return "image";
  }

  if (/\.(mp3|wav|m4a|aac|ogg|flac|opus|webm)$/.test(loweredName)) {
    return "audio";
  }

  return null;
}

function formatAttachmentSize(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }

  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function releaseAttachmentPreviews(attachments?: MessageAttachment[]) {
  attachments?.forEach((attachment) => {
    if (attachment.previewUrl) {
      URL.revokeObjectURL(attachment.previewUrl);
    }
  });
}

function renderMessageAttachments(attachments?: MessageAttachment[]) {
  if (!attachments?.length) {
    return null;
  }

  return (
    <div
      style={{
        marginBottom: 14,
        display: "grid",
        gap: 10,
      }}
    >
      {attachments.map((attachment) => (
        <div
          key={attachment.id}
          style={{
            borderRadius: 18,
            border: "1px solid rgba(255,255,255,0.08)",
            background: "rgba(2,6,23,0.48)",
            padding: 12,
          }}
        >
          {attachment.kind === "image" && attachment.previewUrl ? (
            <img
              src={attachment.previewUrl}
              alt={attachment.displayName}
              style={{
                display: "block",
                width: "100%",
                maxHeight: 220,
                objectFit: "cover",
                borderRadius: 14,
                marginBottom: 10,
              }}
            />
          ) : attachment.kind === "audio" && attachment.previewUrl ? (
            <audio
              controls
              src={attachment.previewUrl}
              style={{ width: "100%", marginBottom: 10 }}
            />
          ) : null}

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <Text
                style={{
                  display: "block",
                  color: "#f8fafc",
                  fontSize: 13,
                  fontWeight: 500,
                }}
                ellipsis
              >
                {attachment.displayName}
              </Text>
              <Text style={{ color: "#94a3b8", fontSize: 12 }}>
                {attachment.kind === "image" ? "图片" : "音频"} ·{" "}
                {formatAttachmentSize(attachment.sizeBytes)}
                {attachment.assetId ? ` · ${attachment.assetId}` : ""}
              </Text>
            </div>

            <Tag
              color={attachment.kind === "image" ? "blue" : "cyan"}
              style={{ marginInlineEnd: 0 }}
            >
              {attachment.kind}
            </Tag>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function App() {
  // mode: 当前使用在线模式还是本地模式
  // backendStatuses: 后端环境变量配置状态
  // messages: 页面消息流
  // input: 当前聊天输入
  // runtimeNotice: 当前运行阶段提示
  // appError: 顶部错误提示
  // loadingStatuses: 是否正在读取后端配置状态
  // running: 当前是否正在执行整轮模型代理
  const [mode, setMode] = useState<AgentMode>("online");
  const [backendStatuses, setBackendStatuses] =
    useState<BackendModeStatuses | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [runtimeNotice, setRuntimeNotice] = useState("等待你输入需求");
  const [appError, setAppError] = useState<string | null>(null);
  const [loadingStatuses, setLoadingStatuses] = useState(true);
  const [running, setRunning] = useState(false);
  const [approvalCommand, setApprovalCommand] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<MainPanel>("chat");
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [loadingSkills, setLoadingSkills] = useState(true);
  const [updatingSkillIds, setUpdatingSkillIds] = useState<string[]>([]);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>(
    [],
  );
  const [dragActive, setDragActive] = useState(false);

  // conversationRef 保存真正传给后端模型代理的对话历史。
  const conversationRef = useRef<ConversationMessage[]>([]);
  const activeStreamIdRef = useRef<string | null>(null);
  const currentAssistantMessageIdRef = useRef<string | null>(null);
  const messageScrollRef = useRef<HTMLDivElement | null>(null);
  const approvalResolverRef = useRef<((allowed: boolean) => void) | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const messagesRef = useRef<UiMessage[]>([]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    return () => {
      messagesRef.current.forEach((message) => {
        releaseAttachmentPreviews(message.attachments);
      });
    };
  }, []);

  useEffect(() => {
    const container = messageScrollRef.current;

    if (!container || activePanel !== "chat") {
      return;
    }

    const frame = requestAnimationFrame(() => {
      container.scrollTo({
        top: container.scrollHeight,
        behavior: "auto",
      });
    });

    return () => cancelAnimationFrame(frame);
  }, [activePanel, messages, runtimeNotice]);

  useEffect(() => {
    const loadStatuses = async () => {
      try {
        const statuses = await invoke<BackendModeStatuses>(
          "get_backend_mode_statuses",
        );
        setBackendStatuses(statuses);

        // 如果在线模式未配置而本地模式已配置，则默认切到本地模式，减少首次使用阻力。
        if (!statuses.online.configured && statuses.local.configured) {
          setMode("local");
        }
      } catch (error) {
        setAppError(formatUnknownError(error));
      } finally {
        setLoadingStatuses(false);
      }
    };

    void loadStatuses();
  }, []);

  useEffect(() => {
    const loadSkills = async () => {
      try {
        const skillSummaries = await invoke<SkillSummary[]>("get_skill_summaries");
        setSkills(skillSummaries);
      } catch (error) {
        setAppError(formatUnknownError(error));
      } finally {
        setLoadingSkills(false);
      }
    };

    void loadSkills();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const setupListener = async () => {
      unlisten = await listen<Record<string, unknown>>(
        STREAM_EVENT_NAME,
        (event) => {
          if (cancelled) {
            return;
          }

          const payload = event.payload;
          const streamId = readEventField<string>(
            payload,
            "streamId",
            "stream_id",
          );
          const kind = payload.kind as AgentStreamEvent["kind"] | undefined;

          if (
            !activeStreamIdRef.current ||
            streamId !== activeStreamIdRef.current
          ) {
            return;
          }

          switch (kind) {
            case "status":
              setRuntimeNotice(
                readEventField<string>(payload, "message", "message") ?? "",
              );
              break;
            case "assistant-start": {
              const assistantMessage = createUiMessage(
                "assistant",
                "助手",
                "",
                "streaming",
              );
              currentAssistantMessageIdRef.current = assistantMessage.id;
              setMessages((current) => [...current, assistantMessage]);
              break;
            }
            case "assistant-delta": {
              const currentAssistantId = currentAssistantMessageIdRef.current;

              if (!currentAssistantId) {
                return;
              }

              const delta =
                readEventField<string>(payload, "delta", "delta") ?? "";

              setMessages((current) =>
                current.map((message) =>
                  message.id === currentAssistantId
                    ? { ...message, content: `${message.content}${delta}` }
                    : message,
                ),
              );
              break;
            }
            case "assistant-complete": {
              const currentAssistantId = currentAssistantMessageIdRef.current;
              const content =
                readEventField<string>(payload, "content", "content") ?? "";
              const hasToolCalls =
                readEventField<boolean>(
                  payload,
                  "hasToolCalls",
                  "has_tool_calls",
                ) ?? false;
              const finalContent = content.trim()
                ? content
                : hasToolCalls
                  ? ""
                  : "(模型本轮没有返回可显示文本)";

              if (!currentAssistantId) {
                if (finalContent) {
                  setMessages((current) => [
                    ...current,
                    createUiMessage("assistant", "助手", finalContent),
                  ]);
                }
                break;
              }

              setMessages((current) =>
                current
                  .map((message) =>
                    message.id === currentAssistantId
                      ? {
                          ...message,
                          content: message.content || finalContent,
                          status: "completed" as const,
                        }
                      : message,
                  )
                  .filter(
                    (message) =>
                      !(
                        message.id === currentAssistantId &&
                        !message.content.trim() &&
                        hasToolCalls
                      ),
                  ),
              );
              currentAssistantMessageIdRef.current = null;
              break;
            }
            case "tool-call": {
              // 工具确认与展示改由前端主循环统一处理，避免重复插入消息。
              break;
            }
            case "command-output": {
              const commandId =
                readEventField<string>(payload, "commandId", "command_id") ?? "";
              const line = readEventField<string>(payload, "line", "line") ?? "";
              const streamKind =
                readEventField<string>(payload, "streamKind", "stream_kind") ??
                "stdout";

              if (!commandId) {
                break;
              }

              setMessages((current) =>
                current.map((message) =>
                  message.id === commandId
                    ? {
                        ...message,
                        content: `${message.content}${
                          message.content ? "\n" : ""
                        }${streamKind === "stderr" ? `[stderr] ${line}` : line}`,
                      }
                    : message,
                ),
              );
              break;
            }
            case "command-complete": {
              const commandId =
                readEventField<string>(payload, "commandId", "command_id") ?? "";
              const success =
                readEventField<boolean>(payload, "success", "success") ?? false;

              if (!commandId) {
                break;
              }

              setMessages((current) =>
                current.map((message) =>
                  message.id === commandId
                    ? {
                        ...message,
                        status: success ? "completed" : "error",
                      }
                    : message,
                ),
              );
              break;
            }
            case "tool-result": {
              const output =
                readEventField<string>(payload, "output", "output") ?? "";
              const success =
                readEventField<boolean>(payload, "success", "success") ?? false;
              setMessages((current) => [
                ...current,
                createUiMessage(
                  "tool-result",
                  "终端结果",
                  output,
                  success ? "completed" : "error",
                ),
              ]);
              break;
            }
            default:
              break;
          }
        },
      );
    };

    void setupListener();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const activeStatus = backendStatuses?.[mode];
  const canSend =
    (Boolean(input.trim()) || pendingAttachments.length > 0) &&
    !running &&
    !loadingStatuses &&
    Boolean(activeStatus?.configured);

  const statusDot = useMemo(() => {
    if (loadingStatuses) {
      return <Badge color="#64748b" />;
    }

    return activeStatus?.configured ? (
      <CheckCircleFilled style={{ color: "#22c55e", fontSize: 13 }} />
    ) : (
      <WarningFilled style={{ color: "#f43f5e", fontSize: 13 }} />
    );
  }, [activeStatus?.configured, loadingStatuses]);

  const recentPrompts = useMemo(
    () =>
      messages
        .filter((message) => message.kind === "user")
        .map((message) => message.content)
        .reverse()
        .slice(0, 8),
    [messages],
  );

  const toggleMode = () => {
    setMode((current) => (current === "online" ? "local" : "online"));
    setAppError(null);
  };

  const handleSkillToggle = async (skillId: string, enabled: boolean) => {
    setUpdatingSkillIds((current) => [...current, skillId]);

    try {
      const updatedSkill = await invoke<SkillSummary>("update_skill_enabled", {
        request: {
          skillId,
          enabled,
        },
      });

      setSkills((current) =>
        current.map((skill) => (skill.id === updatedSkill.id ? updatedSkill : skill)),
      );
    } catch (error) {
      setAppError(formatUnknownError(error));
    } finally {
      setUpdatingSkillIds((current) =>
        current.filter((currentSkillId) => currentSkillId !== skillId),
      );
    }
  };

  const requestCommandApproval = (command: string) =>
    new Promise<boolean>((resolve) => {
      approvalResolverRef.current = resolve;
      setApprovalCommand(command);
    });

  const resolveCommandApproval = (allowed: boolean) => {
    approvalResolverRef.current?.(allowed);
    approvalResolverRef.current = null;
    setApprovalCommand(null);
  };

  const appendAttachments = (files: File[]) => {
    const supportedAttachments: PendingAttachment[] = [];

    for (const file of files) {
      const kind = inferAssetKind(file);

      if (!kind) {
        continue;
      }

      supportedAttachments.push({
        id: createClientId("attachment"),
        file,
        kind,
        previewUrl: kind === "image" ? URL.createObjectURL(file) : undefined,
      });
    }

    if (!supportedAttachments.length) {
      setAppError("仅支持图片和音频文件作为附件。");
      return;
    }

    setPendingAttachments((current) => [...current, ...supportedAttachments]);
    setAppError(null);
  };

  const removePendingAttachment = (attachmentId: string) => {
    setPendingAttachments((current) => {
      const target = current.find((attachment) => attachment.id === attachmentId);
      if (target?.previewUrl) {
        URL.revokeObjectURL(target.previewUrl);
      }

      return current.filter((attachment) => attachment.id !== attachmentId);
    });
  };

  const resetPendingAttachments = () => {
    setPendingAttachments((current) => {
      current.forEach((attachment) => {
        if (attachment.previewUrl) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      });
      return [];
    });
  };

  const openAttachmentPicker = () => {
    fileInputRef.current?.click();
  };

  const handleAttachmentInputChange = (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const files = event.target.files ? Array.from(event.target.files) : [];
    if (files.length > 0) {
      appendAttachments(files);
    }

    event.target.value = "";
  };

  const handleComposerPaste = (
    event: React.ClipboardEvent<HTMLTextAreaElement>,
  ) => {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));

    if (!files.length) {
      return;
    }

    event.preventDefault();
    appendAttachments(files);
  };

  const handleComposerDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!dragActive) {
      setDragActive(true);
    }
  };

  const handleComposerDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }

    setDragActive(false);
  };

  const handleComposerDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);

    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) {
      appendAttachments(files);
    }
  };

  const registerPendingAttachments = async (): Promise<AssetSummary[]> => {
    const registeredAssets: AssetSummary[] = [];

    for (const attachment of pendingAttachments) {
      const bytes = Array.from(new Uint8Array(await attachment.file.arrayBuffer()));
      const asset = await invoke<AssetSummary>("register_asset", {
        request: {
          fileName: attachment.file.name,
          mimeType: attachment.file.type || "application/octet-stream",
          bytes,
        } satisfies RegisterAssetRequest,
      });
      registeredAssets.push(asset);
    }

    return registeredAssets;
  };

  const buildMessageAttachments = (assets: AssetSummary[]): MessageAttachment[] =>
    pendingAttachments.map((attachment, index) => ({
      id: attachment.id,
      kind: attachment.kind,
      displayName: attachment.file.name,
      mimeType: attachment.file.type || "application/octet-stream",
      sizeBytes: attachment.file.size,
      previewUrl: URL.createObjectURL(attachment.file),
      assetId: assets[index]?.assetId,
    }));

  const buildPromptWithAssets = (prompt: string, assets: AssetSummary[]) => {
    if (!assets.length) {
      return prompt;
    }

    const normalizedPrompt = prompt.trim();
    const attachmentLines = assets.map(
      (asset, index) =>
        `${index + 1}. kind=${asset.kind}; asset_id=${asset.assetId}; name=${asset.displayName}; mime=${asset.mimeType}; size=${asset.sizeBytes}`,
    );
    const basePrompt = normalizedPrompt || "请先分析我附加的资源，再回答。";

    return `${basePrompt}\n\n附加资源：\n${attachmentLines.join(
      "\n",
    )}\n\n如果需要识别图片，请调用 analyze_image；如果需要识别音频，请调用 transcribe_audio。`;
  };

  const executeToolCall = async (
    toolCall: ToolFunctionCall,
    streamId: string,
  ): Promise<string> => {
    switch (toolCall.function.name) {
      case "execute_terminal_command": {
        const { command } = parseExecuteTerminalCommandArguments(
          toolCall.function.arguments,
        );

        setMessages((current) => [
          ...current,
          createUiMessage(
            "tool-call",
            "安全确认",
            `AI 请求执行以下命令：\n\n${command}`,
          ),
        ]);
        setRuntimeNotice("等待你确认执行终端命令...");

        const allowed = await requestCommandApproval(command);
        let toolOutput: string;
        const commandMessageId = createClientId("terminal");

        if (allowed) {
          setRuntimeNotice(`正在执行终端命令：${command}`);
          setMessages((current) => [
            ...current,
            {
              id: commandMessageId,
              kind: "tool-result",
              title: "终端结果",
              content: "",
              status: "streaming",
            },
          ]);

          try {
            const output = await invoke<string>("run_command", {
              request: {
                command,
                streamId,
                commandId: commandMessageId,
              } satisfies RunCommandRequest,
            });
            toolOutput = output.trim()
              ? output
              : "(命令执行成功，但没有输出)";
            setMessages((current) =>
              current.map((message) =>
                message.id === commandMessageId
                  ? {
                      ...message,
                      content: message.content || toolOutput,
                      status: "completed",
                    }
                  : message,
              ),
            );
          } catch (error) {
            toolOutput = `命令执行失败：\n${formatUnknownError(error)}`;
            setMessages((current) =>
              current.map((message) =>
                message.id === commandMessageId
                  ? {
                      ...message,
                      content: message.content || toolOutput,
                      status: "error",
                    }
                  : message,
              ),
            );
          }
        } else {
          toolOutput = `用户拒绝执行命令：\n${command}`;
          setMessages((current) => [
            ...current,
            createUiMessage("tool-result", "终端结果", toolOutput, "error"),
          ]);
        }

        return toolOutput;
      }
      case "duckduckgo_search": {
        const { query, maxResults } = parseDuckDuckGoSearchArguments(
          toolCall.function.arguments,
        );
        const searchMessageId = createClientId("duckduckgo");

        setMessages((current) => [
          ...current,
          createUiMessage(
            "tool-call",
            "DuckDuckGo 搜索",
            `查询词：${query}\n最大结果数：${maxResults}`,
          ),
          {
            id: searchMessageId,
            kind: "tool-result",
            title: "搜索结果",
            content: "",
            status: "streaming",
          },
        ]);
        setRuntimeNotice(`正在使用 DuckDuckGo 搜索：${query}`);

        try {
          const output = await invoke<string>("run_duckduckgo_search", {
            request: {
              query,
              maxResults,
            } satisfies RunDuckDuckGoSearchRequest,
          });
          const toolOutput = output.trim()
            ? output
            : "(DuckDuckGo 搜索成功，但没有返回结果)";

          setMessages((current) =>
            current.map((message) =>
              message.id === searchMessageId
                ? {
                    ...message,
                    content: toolOutput,
                    status: "completed",
                  }
                : message,
            ),
          );

          return toolOutput;
        } catch (error) {
          const toolOutput = `DuckDuckGo 搜索失败：\n${formatUnknownError(error)}`;

          setMessages((current) =>
            current.map((message) =>
              message.id === searchMessageId
                ? {
                    ...message,
                    content: toolOutput,
                    status: "error",
                  }
                : message,
            ),
          );

          return toolOutput;
        }
      }
      case "analyze_image": {
        const { assetId, task, ocr } = parseAnalyzeImageArguments(
          toolCall.function.arguments,
        );
        const toolMessageId = createClientId("image-analysis");

        setMessages((current) => [
          ...current,
          createUiMessage(
            "tool-call",
            "图像识别",
            `asset_id：${assetId}${task ? `\n任务：${task}` : ""}\nOCR：${
              ocr ? "true" : "false"
            }`,
          ),
          {
            id: toolMessageId,
            kind: "tool-result",
            title: "图像识别结果",
            content: "",
            status: "streaming",
          },
        ]);
        setRuntimeNotice(`正在分析图片：${assetId}`);

        try {
          const output = await invoke<string>("run_analyze_image", {
            request: {
              mode,
              assetId,
              ...(task ? { task } : {}),
              ...(ocr ? { ocr } : {}),
            } satisfies AnalyzeImageRequest,
          });
          const toolOutput = output.trim()
            ? output
            : "(图像识别成功，但没有返回结果)";

          setMessages((current) =>
            current.map((message) =>
              message.id === toolMessageId
                ? {
                    ...message,
                    content: toolOutput,
                    status: "completed",
                  }
                : message,
            ),
          );

          return toolOutput;
        } catch (error) {
          const toolOutput = `图像识别失败：\n${formatUnknownError(error)}`;

          setMessages((current) =>
            current.map((message) =>
              message.id === toolMessageId
                ? {
                    ...message,
                    content: toolOutput,
                    status: "error",
                  }
                : message,
            ),
          );

          return toolOutput;
        }
      }
      case "transcribe_audio": {
        const { assetId, language, prompt } = parseTranscribeAudioArguments(
          toolCall.function.arguments,
        );
        const toolMessageId = createClientId("audio-transcription");

        setMessages((current) => [
          ...current,
          createUiMessage(
            "tool-call",
            "音频转写",
            `asset_id：${assetId}${
              language ? `\n语言：${language}` : ""
            }${prompt ? `\n提示：${prompt}` : ""}`,
          ),
          {
            id: toolMessageId,
            kind: "tool-result",
            title: "音频转写结果",
            content: "",
            status: "streaming",
          },
        ]);
        setRuntimeNotice(`正在转写音频：${assetId}`);

        try {
          const output = await invoke<string>("run_transcribe_audio", {
            request: {
              mode,
              assetId,
              ...(language ? { language } : {}),
              ...(prompt ? { prompt } : {}),
            } satisfies TranscribeAudioRequest,
          });
          const toolOutput = output.trim()
            ? output
            : "(音频转写成功，但没有返回结果)";

          setMessages((current) =>
            current.map((message) =>
              message.id === toolMessageId
                ? {
                    ...message,
                    content: toolOutput,
                    status: "completed",
                  }
                : message,
            ),
          );

          return toolOutput;
        } catch (error) {
          const toolOutput = `音频转写失败：\n${formatUnknownError(error)}`;

          setMessages((current) =>
            current.map((message) =>
              message.id === toolMessageId
                ? {
                    ...message,
                    content: toolOutput,
                    status: "error",
                  }
                : message,
            ),
          );

          return toolOutput;
        }
      }
      default:
        throw new Error(`模型请求了未支持的工具：${toolCall.function.name}`);
    }
  };

  const resetConversation = () => {
    messages.forEach((message) => {
      releaseAttachmentPreviews(message.attachments);
    });
    setMessages([]);
    resetPendingAttachments();
    setRuntimeNotice("等待你输入需求");
    conversationRef.current = [];
    currentAssistantMessageIdRef.current = null;
    setActivePanel("chat");
  };

  const handleSubmit = async () => {
    const prompt = input.trim();

    if ((!prompt && pendingAttachments.length === 0) || running) {
      return;
    }

    if (!activeStatus?.configured) {
      setAppError(activeStatus?.message ?? "当前模式未配置完成。");
      setRuntimeNotice("无法发送请求");
      return;
    }

    setAppError(null);
    setRuntimeNotice("正在准备附件并启动后端代理...");

    const registeredAssets = await registerPendingAttachments();
    const finalPrompt = buildPromptWithAssets(prompt, registeredAssets);
    const messageAttachments = buildMessageAttachments(registeredAssets);
    const displayPrompt = prompt || "请先分析我附加的资源。";
    const nextConversation = [
      ...conversationRef.current,
      {
        role: "user",
        content: finalPrompt,
      } satisfies ConversationMessage,
    ];

    setMessages((current) => [
      ...current,
      createUiMessage("user", "你", displayPrompt, "completed", messageAttachments),
    ]);
    conversationRef.current = nextConversation;
    setInput("");
    resetPendingAttachments();
    setRunning(true);
    setActivePanel("chat");
    setRuntimeNotice("正在启动后端代理...");

    const streamId = createClientId("stream");
    activeStreamIdRef.current = streamId;
    currentAssistantMessageIdRef.current = null;

    try {
      let currentConversation = nextConversation;

      for (let round = 0; round < MAX_TOOL_CALL_ROUNDS; round += 1) {
        const result = await invoke<RunAgentTurnResult>("run_agent_turn", {
          request: {
            mode,
            streamId,
            messages: currentConversation,
          } satisfies RunAgentTurnRequest,
        });

        const normalizedMessages = result.newMessages.map((message) => ({
          role: message.role,
          content: message.content,
          ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
          ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
        })) as ConversationMessage[];

        currentConversation = [...currentConversation, ...normalizedMessages];
        conversationRef.current = currentConversation;

        const assistantMessage = [...result.newMessages]
          .reverse()
          .find(
            (message) =>
              message.role === "assistant" &&
              Array.isArray(message.toolCalls) &&
              message.toolCalls.length > 0,
          );

        const toolCalls = assistantMessage?.toolCalls ?? [];

        if (!toolCalls.length) {
          setRuntimeNotice("本轮对话已完成");
          break;
        }

        if (round === MAX_TOOL_CALL_ROUNDS - 1) {
          throw new Error(
            `工具调用超过最大轮次限制（${MAX_TOOL_CALL_ROUNDS}），已自动停止。`,
          );
        }

        for (const toolCall of toolCalls) {
          {
            const toolOutput = await executeToolCall(toolCall, streamId);

            currentConversation = [
              ...currentConversation,
              {
                role: "tool",
                content: toolOutput,
                toolCallId: toolCall.id,
              },
            ];
            conversationRef.current = currentConversation;
            setRuntimeNotice(
              `已将 ${toolCall.function.name} 的结果回传给模型，继续推理...`,
            );
            continue;
          }
          if (toolCall.function.name !== "execute_terminal_command") {
            throw new Error(
              `模型请求了未支持的工具：${toolCall.function.name}`,
            );
          }

          const { command } = parseExecuteTerminalCommandArguments(
            toolCall.function.arguments,
          );

          setMessages((current) => [
            ...current,
            createUiMessage(
              "tool-call",
              "安全确认",
              `AI 请求执行以下命令：\n\n${command}`,
            ),
          ]);
          setRuntimeNotice("等待你确认执行终端命令...");

          const allowed = await requestCommandApproval(command);
          let toolOutput: string;
          let success = false;
          const commandMessageId = createClientId("terminal");

          if (allowed) {
            setRuntimeNotice(`正在执行终端命令：${command}`);
            setMessages((current) => [
              ...current,
              {
                id: commandMessageId,
                kind: "tool-result",
                title: "终端结果",
                content: "",
                status: "streaming",
              },
            ]);

            try {
              const output = await invoke<string>("run_command", {
                request: {
                  command,
                  streamId,
                  commandId: commandMessageId,
                } satisfies RunCommandRequest,
              });
              toolOutput = output.trim()
                ? output
                : "(命令执行成功，但没有输出)";
              success = true;
              setMessages((current) =>
                current.map((message) =>
                  message.id === commandMessageId
                    ? {
                        ...message,
                        content: message.content || toolOutput,
                        status: "completed",
                      }
                    : message,
                ),
              );
            } catch (error) {
              toolOutput = `命令执行失败：\n${formatUnknownError(error)}`;
              setMessages((current) =>
                current.map((message) =>
                  message.id === commandMessageId
                    ? {
                        ...message,
                        content: message.content || toolOutput,
                        status: "error",
                      }
                    : message,
                ),
              );
            }
          } else {
            toolOutput = `用户拒绝执行命令：\n${command}`;
            setMessages((current) => [
              ...current,
              createUiMessage("tool-result", "终端结果", toolOutput, "error"),
            ]);
          }

          currentConversation = [
            ...currentConversation,
            {
              role: "tool",
              content: toolOutput,
              toolCallId: toolCall.id,
            },
          ];
          conversationRef.current = currentConversation;
          setRuntimeNotice("已将终端结果回传给模型，继续推理...");
        }
      }
    } catch (error) {
      const message = formatUnknownError(error);
      setAppError(message);
      setRuntimeNotice("代理执行失败");
      setMessages((current) => [
        ...current,
        createUiMessage("error", "系统", message, "error"),
      ]);
    } finally {
      setRunning(false);
      activeStreamIdRef.current = null;
      currentAssistantMessageIdRef.current = null;
    }
  };

  return (
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: "#1677ff",
          colorTextBase: "#f8fafc",
          colorBgBase: "#0b1120",
          colorBorder: "rgba(255,255,255,0.08)",
          borderRadius: 18,
          fontFamily: '"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',
        },
        components: {
          Layout: {
            bodyBg: "transparent",
            siderBg: "transparent",
            headerBg: "transparent",
            footerBg: "transparent",
          },
          Segmented: {
            itemSelectedBg: "rgba(255,255,255,0.12)",
            itemHoverBg: "rgba(255,255,255,0.08)",
            trackBg: "rgba(255,255,255,0.04)",
          },
          Input: {
            colorBgContainer: "transparent",
            colorBorder: "transparent",
            activeBorderColor: "transparent",
            hoverBorderColor: "transparent",
            activeShadow: "none",
          },
        },
      }}
    >
      <Layout
        style={{
          height: "100vh",
          overflow: "hidden",
          background:
            "radial-gradient(circle at top, rgba(59,130,246,0.18), transparent 26%), linear-gradient(180deg, #080b12 0%, #0b0f17 52%, #0d1118 100%)",
          padding: 16,
        }}
      >
        <Layout
          style={{
            maxWidth: 1480,
            width: "100%",
            margin: "0 auto",
            height: "100%",
            background: "transparent",
            gap: 16,
            flexDirection: "row",
          }}
        >
          <Sider
            width={248}
            style={{
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 28,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                padding: 20,
                display: "flex",
                flexDirection: "column",
              }}
            >
              <div style={{ flexShrink: 0 }}>
                <Space
                  direction="vertical"
                  size={4}
                  style={{ display: "flex", marginBottom: 24 }}
                >
                  <Title
                    level={3}
                    style={{
                      margin: 0,
                      color: "#f8fafc",
                      fontWeight: 600,
                      letterSpacing: -0.6,
                    }}
                  >
                    HZCUclaw
                  </Title>
                  <Paragraph
                    style={{
                      margin: 0,
                      color: "#94a3b8",
                      lineHeight: 1.7,
                    }}
                  >
                     跨平台AI辅助工具
                  </Paragraph>
                </Space>

                <div
                  style={{
                    borderRadius: 24,
                    border: "1px solid rgba(255,255,255,0.08)",
                    background: "rgba(5,10,18,0.6)",
                    padding: 18,
                  }}
                >
                  <Text
                    style={{
                      display: "block",
                      color: "#94a3b8",
                      fontSize: 12,
                      letterSpacing: 1.6,
                      marginBottom: 12,
                    }}
                  >
                    工作模式
                  </Text>
                  <Segmented
                    block
                    size="large"
                    value={mode}
                    onChange={(value) => setMode(value as AgentMode)}
                    disabled={running || loadingStatuses}
                    options={[
                      {
                        label: (
                          <Space size={8}>
                            <ApiOutlined />
                            在线
                          </Space>
                        ),
                        value: "online",
                      },
                      {
                        label: (
                          <Space size={8}>
                            <RobotOutlined />
                            本地
                          </Space>
                        ),
                        value: "local",
                      },
                    ]}
                  />

                </div>

                <div
                  style={{
                    marginTop: 18,
                    borderRadius: 24,
                    border: "1px solid rgba(255,255,255,0.08)",
                    background: "rgba(5,10,18,0.6)",
                    padding: 18,
                  }}
                >
                  <Text
                    style={{
                      display: "block",
                      color: "#94a3b8",
                      fontSize: 12,
                      letterSpacing: 1.6,
                      marginBottom: 12,
                    }}
                  >
                    快捷入口
                  </Text>
                  <Space direction="vertical" size={10} style={{ display: "flex" }}>
                    <Button
                      block
                      icon={<MessageOutlined />}
                      style={buttonGhostStyle}
                      onClick={() => {
                        resetConversation();
                        setActivePanel("chat");
                      }}
                      disabled={running}
                    >
                      新建对话
                    </Button>
                    <Button
                      block
                      icon={<DesktopOutlined />}
                      style={buttonGhostStyle}
                      onClick={toggleMode}
                      disabled={running || loadingStatuses}
                    >
                      切换到{MODE_LABELS[mode === "online" ? "local" : "online"]}
                    </Button>
                    <Button
                      block
                      icon={<ThunderboltOutlined />}
                      style={buttonGhostStyle}
                      onClick={resetConversation}
                      disabled={running}
                    >
                      清空历史
                    </Button>
                  </Space>
                </div>
              </div>

              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  overflowY: "auto",
                  marginTop: 18,
                  paddingRight: 4,
                }}
              >
                <Text
                  style={{
                    display: "block",
                    color: "#94a3b8",
                    fontSize: 12,
                    letterSpacing: 1.6,
                    marginBottom: 12,
                  }}
                >
                  导航与历史
                </Text>

                <Space direction="vertical" size={10} style={{ display: "flex" }}>
                  <Button
                    block
                    icon={<MessageOutlined />}
                    style={navButtonStyle(activePanel === "chat")}
                    onClick={() => setActivePanel("chat")}
                  >
                    对话工作台
                  </Button>
                  <Button
                    block
                    icon={<FileTextOutlined />}
                    style={navButtonStyle(activePanel === "skills")}
                    onClick={() => setActivePanel("skills")}
                  >
                    技能列表 ({skills.length})
                  </Button>
                </Space>

                <div
                  style={{
                    marginTop: 18,
                    borderRadius: 20,
                    border: "1px solid rgba(255,255,255,0.08)",
                    background: "rgba(255,255,255,0.03)",
                    padding: 14,
                  }}
                >
                  <Text
                    style={{
                      display: "block",
                      color: "#94a3b8",
                      fontSize: 12,
                      letterSpacing: 1.2,
                      marginBottom: 10,
                    }}
                  >
                    当前会话
                  </Text>

                  {recentPrompts.length === 0 ? (
                    <Text style={{ color: "#64748b", fontSize: 12 }}>
                      这里将用于展示持久化历史与最近对话。
                    </Text>
                  ) : (
                    <Space direction="vertical" size={8} style={{ display: "flex" }}>
                      {recentPrompts.map((prompt, index) => (
                        <button
                          key={`${prompt}-${index}`}
                          type="button"
                          onClick={() => setActivePanel("chat")}
                          style={{
                            width: "100%",
                            border: "1px solid rgba(255,255,255,0.06)",
                            background: "rgba(255,255,255,0.02)",
                            color: "#cbd5e1",
                            textAlign: "left",
                            borderRadius: 14,
                            padding: "10px 12px",
                            cursor: "pointer",
                            fontSize: 12,
                            lineHeight: 1.6,
                          }}
                        >
                          {prompt}
                        </button>
                      ))}
                    </Space>
                  )}
                </div>
              </div>

              <div
                style={{
                  flexShrink: 0,
                  paddingTop: 20,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <Space size={10} align="center">
                  {statusDot}
                  <Text style={{ color: "#cbd5e1", fontSize: 13 }}>
                    后端状态
                  </Text>
                </Space>
                <Text
                  style={{
                    color: loadingStatuses
                      ? "#94a3b8"
                      : activeStatus?.configured
                        ? "#22c55e"
                        : "#f87171",
                    fontSize: 12,
                    letterSpacing: 1.1,
                  }}
                >
                  {loadingStatuses
                    ? "LOADING"
                    : activeStatus?.configured
                      ? "READY"
                      : "ERROR"}
                </Text>
              </div>
            </div>
          </Sider>

          <Content
            style={{
              minWidth: 0,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
              background: "rgba(255,255,255,0.035)",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 28,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                padding: "20px 28px 18px",
                borderBottom: "1px solid rgba(255,255,255,0.08)",
              }}
            >
              <div
                style={{
                  maxWidth: 900,
                  margin: "0 auto",
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 16,
                }}
              >
                <div>
                  <Title
                    level={4}
                    style={{ margin: 0, color: "#f8fafc", fontWeight: 600 }}
                  >
                    {activePanel === "chat" ? "对话与执行流" : "技能列表"}
                  </Title>
                </div>
                <div
                  style={{
                    borderRadius: 999,
                    border: "1px solid rgba(255,255,255,0.08)",
                    background: "rgba(5,10,18,0.55)",
                    padding: "8px 14px",
                    minWidth: 160,
                    textAlign: "center",
                  }}
                >
                  <Text style={{ color: "#cbd5e1", fontSize: 13 }}>
                    {activePanel === "chat"
                      ? runtimeNotice
                      : loadingSkills
                        ? "正在读取技能..."
                        : `已加载 ${skills.length} 个技能`}
                  </Text>
                </div>
              </div>

              {appError ? (
                <div style={{ maxWidth: 900, margin: "16px auto 0", width: "100%" }}>
                  <Alert
                    type="error"
                    showIcon
                    message={appError}
                    style={{
                      borderRadius: 18,
                      background: "rgba(127,29,29,0.25)",
                      border: "1px solid rgba(248,113,113,0.2)",
                    }}
                  />
                </div>
              ) : null}
            </div>

            {activePanel === "chat" ? (
              <>
                <div
                  ref={messageScrollRef}
                  style={{
                    flex: 1,
                    minHeight: 0,
                    overflowY: "auto",
                    padding: "24px 28px 12px",
                  }}
                >
                  <div style={{ maxWidth: 900, margin: "0 auto", width: "100%" }}>
                    {messages.length === 0 ? (
                      <div
                        style={{
                          minHeight: "100%",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Empty
                          image={Empty.PRESENTED_IMAGE_SIMPLE}
                          description={
                            <Space direction="vertical" size={6}>
                              <Text style={{ color: "#f8fafc", fontSize: 16 }}>
                                从一个需求开始
                              </Text>
                              <Text style={{ color: "#94a3b8" }}>
                                例如：帮我查看当前目录内容并总结重点文件
                              </Text>
                            </Space>
                          }
                        />
                      </div>
                    ) : (
                      <Space
                        direction="vertical"
                        size={18}
                        style={{ display: "flex", width: "100%" }}
                      >
                        {messages.map((message) => {
                          const tone = getMessageTone(message.kind);

                          return (
                            <div key={message.id} className={`flex ${tone.wrapper}`}>
                              <article
                                className={`w-full max-w-[780px] rounded-[26px] border px-5 py-4 shadow-[0_12px_40px_rgba(0,0,0,0.18)] ${tone.card}`}
                              >
                                <div className="mb-3 flex items-center justify-between gap-3">
                                  <Text
                                    className={tone.title}
                                    style={{ fontSize: 13, fontWeight: 600 }}
                                  >
                                    {message.title}
                                  </Text>
                                  <Text
                                    style={{
                                      color:
                                        message.status === "streaming"
                                          ? "#60a5fa"
                                          : message.status === "error"
                                            ? "#f87171"
                                            : "#94a3b8",
                                      fontSize: 11,
                                      letterSpacing: 1.1,
                                      textTransform: "uppercase",
                                    }}
                                  >
                                    {message.status === "streaming"
                                      ? "Streaming"
                                      : message.status === "error"
                                        ? "Error"
                                        : "Done"}
                                  </Text>
                                </div>
                                {renderMessageAttachments(message.attachments)}
                                {message.kind === "tool-result" ? (
                                  <div
                                    style={{
                                      marginTop: 2,
                                      maxHeight: 260,
                                      overflowY: "auto",
                                      borderRadius: 18,
                                      border: "1px solid rgba(255,255,255,0.08)",
                                      background: "#020617",
                                      padding: "14px 16px",
                                    }}
                                  >
                                    <pre
                                      style={{
                                        margin: 0,
                                        whiteSpace: "pre-wrap",
                                        wordBreak: "break-word",
                                        color: "#dbeafe",
                                        fontSize: 13,
                                        lineHeight: 1.85,
                                        fontFamily:
                                          '"Cascadia Code","Consolas","SFMono-Regular",monospace',
                                      }}
                                    >
                                      {message.content}
                                    </pre>
                                  </div>
                                ) : (
                                  <pre
                                    style={{
                                      margin: 0,
                                      whiteSpace: "pre-wrap",
                                      wordBreak: "break-word",
                                      color: "#f8fafc",
                                      fontSize: 14,
                                      lineHeight: 1.9,
                                      fontFamily:
                                        message.kind === "tool-call"
                                          ? '"Cascadia Code","Consolas","SFMono-Regular",monospace'
                                          : '"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',
                                    }}
                                  >
                                    {message.content}
                                  </pre>
                                )}
                              </article>
                            </div>
                          );
                        })}
                      </Space>
                    )}
                  </div>
                </div>

                <div
                  style={{
                    padding: "16px 24px 24px",
                    borderTop: "1px solid rgba(255,255,255,0.08)",
                    background:
                      "linear-gradient(180deg, rgba(9,14,24,0.2) 0%, rgba(9,14,24,0.75) 38%, rgba(9,14,24,0.95) 100%)",
                  }}
                >
                  <div style={{ maxWidth: 900, margin: "0 auto", width: "100%" }}>
                    <div
                      onDragOver={handleComposerDragOver}
                      onDragLeave={handleComposerDragLeave}
                      onDrop={handleComposerDrop}
                      style={{
                        borderRadius: 30,
                        border: dragActive
                          ? "1px solid rgba(59,130,246,0.55)"
                          : "1px solid rgba(255,255,255,0.08)",
                        background: dragActive
                          ? "rgba(59,130,246,0.08)"
                          : "rgba(255,255,255,0.04)",
                        boxShadow: "0 18px 60px rgba(0, 0, 0, 0.28)",
                        padding: 18,
                        transition: "border-color 0.2s ease, background 0.2s ease",
                      }}
                    >
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*,audio/*"
                        multiple
                        onChange={handleAttachmentInputChange}
                        style={{ display: "none" }}
                      />
                      <TextArea
                        value={input}
                        onChange={(event) => setInput(event.target.value)}
                        onPaste={handleComposerPaste}
                        onKeyDown={(event) => {
                          if (
                            event.key === "Enter" &&
                            (event.ctrlKey || event.metaKey)
                          ) {
                            event.preventDefault();
                            void handleSubmit();
                          }
                        }}
                        autoSize={{ minRows: 2, maxRows: 7 }}
                        placeholder="问问 AI-Universal-Assistant，例如：帮我检查当前目录结构并给出总结。"
                        disabled={running}
                        style={{
                          padding: 0,
                          color: "#f8fafc",
                          background: "transparent",
                          fontSize: 15,
                          lineHeight: 1.9,
                          boxShadow: "none",
                        }}
                      />

                      {pendingAttachments.length > 0 ? (
                        <div
                          style={{
                            marginTop: 16,
                            display: "grid",
                            gap: 10,
                          }}
                        >
                          {pendingAttachments.map((attachment) => (
                            <div
                              key={attachment.id}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                gap: 12,
                                borderRadius: 18,
                                border: "1px solid rgba(255,255,255,0.08)",
                                background: "rgba(2,6,23,0.6)",
                                padding: "10px 12px",
                              }}
                            >
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 12,
                                  minWidth: 0,
                                }}
                              >
                                {attachment.kind === "image" && attachment.previewUrl ? (
                                  <img
                                    src={attachment.previewUrl}
                                    alt={attachment.file.name}
                                    style={{
                                      width: 44,
                                      height: 44,
                                      borderRadius: 12,
                                      objectFit: "cover",
                                      flexShrink: 0,
                                    }}
                                  />
                                ) : (
                                  <div
                                    style={{
                                      width: 44,
                                      height: 44,
                                      borderRadius: 12,
                                      display: "grid",
                                      placeItems: "center",
                                      background: "rgba(148,163,184,0.16)",
                                      color: "#cbd5e1",
                                      fontSize: 12,
                                      flexShrink: 0,
                                    }}
                                  >
                                    音频
                                  </div>
                                )}

                                <div style={{ minWidth: 0 }}>
                                  <Text
                                    style={{
                                      display: "block",
                                      color: "#f8fafc",
                                      fontSize: 13,
                                    }}
                                    ellipsis
                                  >
                                    {attachment.file.name}
                                  </Text>
                                  <Text style={{ color: "#94a3b8", fontSize: 12 }}>
                                    {attachment.kind} ·{" "}
                                    {formatAttachmentSize(attachment.file.size)}
                                  </Text>
                                </div>
                              </div>

                              <Button
                                type="text"
                                size="small"
                                icon={<DeleteOutlined />}
                                onClick={() => removePendingAttachment(attachment.id)}
                              />
                            </div>
                          ))}
                        </div>
                      ) : null}

                      <div
                        style={{
                          marginTop: 16,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 12,
                        }}
                      >
                        <Space size={12}>
                          <Button
                            type="text"
                            icon={<PaperClipOutlined />}
                            onClick={openAttachmentPicker}
                            disabled={running}
                            style={{ color: "#cbd5e1" }}
                          >
                            添加附件
                          </Button>
                          <Text style={{ color: "#94a3b8", fontSize: 13 }}>
                            Ctrl/Cmd + Enter 发送
                          </Text>
                          <Text style={{ color: "#64748b", fontSize: 13 }}>
                            滚动仅作用于聊天历史区域
                          </Text>
                        </Space>

                        <Button
                          type="primary"
                          shape="circle"
                          size="large"
                          icon={running ? <LoadingOutlined /> : <SendOutlined />}
                          onClick={() => void handleSubmit()}
                          disabled={!canSend}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  overflowY: "auto",
                  padding: "28px 28px 28px",
                }}
              >
                <div style={{ maxWidth: 940, margin: "0 auto", width: "100%" }}>
                  <div
                    style={{
                      borderRadius: 24,
                      border: "1px solid rgba(255,255,255,0.08)",
                      background: "rgba(255,255,255,0.03)",
                      padding: "18px 20px",
                      marginBottom: 22,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 16,
                    }}
                  >
                    <Space size={12}>
                      <AppstoreOutlined style={{ color: "#93c5fd", fontSize: 16 }} />
                      <Text style={{ color: "#e2e8f0", fontSize: 14 }}>
                        这里展示你赋予智能体的所有本地技能及其启用状态。
                      </Text>
                    </Space>
                    <Text style={{ color: "#93c5fd", fontSize: 13 }}>
                      {loadingSkills ? "读取中" : `${skills.length} 个技能`}
                    </Text>
                  </div>

                  {loadingSkills ? (
                    <div style={{ padding: "40px 0", textAlign: "center" }}>
                      <Spin indicator={<LoadingOutlined spin />} />
                    </div>
                  ) : skills.length === 0 ? (
                    <div
                      style={{
                        borderRadius: 24,
                        border: "1px dashed rgba(255,255,255,0.08)",
                        background: "rgba(255,255,255,0.03)",
                        padding: 22,
                      }}
                    >
                      <Text style={{ color: "#cbd5e1", fontSize: 14 }}>
                        当前未检测到任何 skills。
                      </Text>
                      <Paragraph
                        style={{
                          margin: "10px 0 0",
                          color: "#94a3b8",
                          fontSize: 13,
                          lineHeight: 1.8,
                        }}
                      >
                        请确认项目根目录下存在 <code>.skills</code> 文件夹，并重启
                        `npm run tauri dev`。
                      </Paragraph>
                    </div>
                  ) : (
                    <Space direction="vertical" size={16} style={{ display: "flex" }}>
                      {skills.map((skill) => {
                        const updating = updatingSkillIds.includes(skill.id);

                        return (
                          <div
                            key={skill.id}
                            style={{
                              borderRadius: 24,
                              border: "1px solid rgba(255,255,255,0.08)",
                              background: "rgba(255,255,255,0.03)",
                              padding: 20,
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                alignItems: "flex-start",
                                justifyContent: "space-between",
                                gap: 20,
                              }}
                            >
                              <div style={{ minWidth: 0 }}>
                                <Text
                                  style={{
                                    color: "#f8fafc",
                                    fontSize: 16,
                                    fontWeight: 600,
                                  }}
                                >
                                  {skill.name}
                                </Text>
                                <div style={{ marginTop: 10 }}>
                                  <Space wrap size={[8, 8]}>
                                    <Tag
                                      color={skill.skillType === "tool" ? "blue" : "purple"}
                                    >
                                      {skill.skillType === "tool" ? "tool" : "prompt"}
                                    </Tag>
                                    <Tag color={skill.enabled ? "green" : "red"}>
                                      {skill.enabled ? "true" : "false"}
                                    </Tag>
                                    {skill.requiresConfirmation ? (
                                      <Tag color="gold">requires-confirmation</Tag>
                                    ) : null}
                                  </Space>
                                </div>
                                <Paragraph
                                  style={{
                                    margin: "14px 0 0",
                                    color: "#94a3b8",
                                    fontSize: 13,
                                    lineHeight: 1.8,
                                  }}
                                >
                                  {skill.description}
                                </Paragraph>
                              </div>

                              <div style={{ flexShrink: 0 }}>
                                <Switch
                                  checked={skill.enabled}
                                  loading={updating}
                                  checkedChildren="true"
                                  unCheckedChildren="false"
                                  onChange={(checked) =>
                                    void handleSkillToggle(skill.id, checked)
                                  }
                                />
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </Space>
                  )}
                </div>
              </div>
            )}
          </Content>
        </Layout>
        <Modal
          open={Boolean(approvalCommand)}
          title="确认执行终端命令"
          okText="允许"
          cancelText="拒绝"
          onOk={() => resolveCommandApproval(true)}
          onCancel={() => resolveCommandApproval(false)}
          closable={!running}
          maskClosable={false}
          destroyOnHidden
        >
          <Paragraph style={{ color: "#94a3b8", marginBottom: 14 }}>
            AI 请求在你的本地系统终端执行以下命令。请确认该命令安全且符合你的预期。
          </Paragraph>
          <div
            style={{
              borderRadius: 18,
              border: "1px solid rgba(255,255,255,0.08)",
              background: "#020617",
              padding: 16,
            }}
          >
            <pre
              style={{
                margin: 0,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                color: "#dbeafe",
                fontSize: 13,
                lineHeight: 1.85,
                fontFamily:
                  '"Cascadia Code","Consolas","SFMono-Regular",monospace',
              }}
            >
              {approvalCommand}
            </pre>
          </div>
        </Modal>
      </Layout>
    </ConfigProvider>
  );
}

const buttonGhostStyle = {
  justifyContent: "flex-start" as const,
  height: 44,
  borderRadius: 16,
  border: "1px solid rgba(255,255,255,0.08)",
  background: "rgba(255,255,255,0.03)",
  color: "#e2e8f0",
  boxShadow: "none",
};

function navButtonStyle(active: boolean) {
  return {
    justifyContent: "flex-start" as const,
    height: 46,
    borderRadius: 16,
    border: active
      ? "1px solid rgba(59,130,246,0.35)"
      : "1px solid rgba(255,255,255,0.06)",
    background: active ? "rgba(59,130,246,0.18)" : "rgba(255,255,255,0.03)",
    color: active ? "#dbeafe" : "#cbd5e1",
    boxShadow: "none",
  };
}
