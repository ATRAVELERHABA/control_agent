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
  SettingOutlined,
  ThunderboltOutlined,
  WarningFilled,
  SearchOutlined,
  PlusOutlined,
  MobileOutlined,
  UserOutlined,
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
  theme as antdTheme,
  Typography,
} from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivationScreen } from "./components/ActivationScreen";
import { AuthScreen } from "./components/AuthScreen";
import { ConversationList } from "./components/ConversationList";
import { MessageAttachments } from "./components/MessageAttachments";
import { formatAttachmentSize } from "./lib/utils";
import {
  UiMessageKind,
  UiMessageStatus,
  MainPanel,
  LicensePhase,
  AuthPhase,
  AuthMode,
  AppearanceMode,
  UiMessage,
  PendingAttachment,
  MessageAttachment,
} from "./types/ui";
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
  type CurrentUser,
  type DingTalkStatus,
  type ImportLicenseRequest,
  type ImportLicenseResult,
  type LicenseStatus,
  type LoginRequest,
  type RegisterAccountRequest,
  type RegisterAssetRequest,
  type RunCommandRequest,
  type RunDuckDuckGoSearchRequest,
  type RunAgentTurnRequest,
  type RunAgentTurnResult,
  type SessionStatus,
  type SkillSummary,
  type SystemPromptSettings,
  type ToolFunctionCall,
  type TranscribeAudioRequest,
  type UpdateSkillRequiresConfirmationRequest,
  type UpdateSystemPromptSettingsRequest,
  type ConversationSummary,
  type CreateConversationRequest,
  type ConversationMessagesRequest,
  type AppendConversationMessagesRequest,
  type DeleteConversationRequest,
} from "./lib/llm";
import avatarImg from "../image/13021.jpg";

const { Sider, Content } = Layout;
const APPEARANCE_MODE_STORAGE_KEY = "qclaw-appearance-mode";
const { Title, Paragraph, Text } = Typography;
const { TextArea } = Input;

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

function getMessageTone(kind: UiMessageKind, light: boolean) {
  if (light) {
    switch (kind) {
      case "user":
        return {
          wrapper: "justify-end",
          card: "border-blue-200 bg-blue-50",
          title: "text-blue-700",
        };
      case "assistant":
        return {
          wrapper: "justify-start",
          card: "border-slate-200 bg-white",
          title: "text-slate-700",
        };
      case "tool-call":
        return {
          wrapper: "justify-start",
          card: "border-amber-200 bg-amber-50",
          title: "text-amber-700",
        };
      case "tool-result":
        return {
          wrapper: "justify-start",
          card: "border-violet-200 bg-violet-50",
          title: "text-violet-700",
        };
      case "error":
        return {
          wrapper: "justify-start",
          card: "border-rose-200 bg-rose-50",
          title: "text-rose-700",
        };
      default:
        return {
          wrapper: "justify-start",
          card: "border-slate-200 bg-white",
          title: "text-slate-700",
        };
    }
  }

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

function releaseAttachmentPreviews(attachments?: MessageAttachment[]) {
  attachments?.forEach((attachment) => {
    if (attachment.previewUrl) {
      URL.revokeObjectURL(attachment.previewUrl);
    }
  });
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dingtalkOpen, setDingtalkOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"general" | "usage" | "skills" | "remote" | "prompt" | "about">("general");
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [loadingSkills, setLoadingSkills] = useState(true);
  const [updatingSkillIds, setUpdatingSkillIds] = useState<string[]>([]);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>(
    [],
  );
  const [dragActive, setDragActive] = useState(false);
  const [licensePhase, setLicensePhase] = useState<LicensePhase>("checking");
  const [licenseStatus, setLicenseStatus] = useState<LicenseStatus | null>(null);
  const [licenseBusy, setLicenseBusy] = useState(false);
  const [licenseError, setLicenseError] = useState<string | null>(null);
  const [authPhase, setAuthPhase] = useState<AuthPhase>("checking");
  const [sessionStatus, setSessionStatus] = useState<SessionStatus | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [dingtalkStatus, setDingtalkStatus] = useState<DingTalkStatus | null>(null);
  const [dingtalkBusy, setDingtalkBusy] = useState(false);
  const [systemPromptSettings, setSystemPromptSettings] =
    useState<SystemPromptSettings | null>(null);
  const [systemPromptDraft, setSystemPromptDraft] = useState("");
  const [loadingSystemPrompt, setLoadingSystemPrompt] = useState(true);
  const [savingSystemPrompt, setSavingSystemPrompt] = useState(false);
  const [appearanceMode, setAppearanceMode] = useState<AppearanceMode>(() => {
    if (typeof window === "undefined") {
      return "system";
    }
    const stored = window.localStorage.getItem(APPEARANCE_MODE_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
    return "system";
  });
  const [systemPrefersDark, setSystemPrefersDark] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);

  const terminalCommandSkill = useMemo(
    () => skills.find((skill) => skill.id === "execute-terminal-command") ?? null,
    [skills],
  );
  const terminalCommandRequiresApproval =
    terminalCommandSkill?.requiresConfirmation ?? true;
  const terminalCommandDirectExecutionEnabled = !terminalCommandRequiresApproval;

  // conversationRef 保存真正传给后端模型代理的对话历史。
  const conversationRef = useRef<ConversationMessage[]>([]);
  const activeStreamIdRef = useRef<string | null>(null);
  const currentAssistantMessageIdRef = useRef<string | null>(null);
  const messageScrollRef = useRef<HTMLDivElement | null>(null);
  const approvalResolverRef = useRef<((allowed: boolean) => void) | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const licenseInputRef = useRef<HTMLInputElement | null>(null);
  const messagesRef = useRef<UiMessage[]>([]);

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

  const clearAuthenticatedState = () => {
    setCurrentUser(null);
    setSessionStatus(null);
    setDingtalkStatus(null);
    setAuthPhase("anonymous");
    setAuthError(null);
    setBackendStatuses(null);
    setLoadingStatuses(true);
    setSkills([]);
    setLoadingSkills(true);
    setSystemPromptSettings(null);
    setSystemPromptDraft("");
    setLoadingSystemPrompt(true);
    setSavingSystemPrompt(false);
    resetPendingAttachments();
    setRunning(false);
    setConversations([]);
    setActiveConversationId(null);
  };

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
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(APPEARANCE_MODE_STORAGE_KEY, appearanceMode);
  }, [appearanceMode]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => {
      setSystemPrefersDark(event.matches);
    };
    setSystemPrefersDark(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const loadLicenseStatus = async () => {
      try {
        const status = await invoke<LicenseStatus>("get_license_status");
        setLicenseStatus(status);
        setLicensePhase(status.valid ? "valid" : "missing");
      } catch (error) {
        setLicenseError(formatUnknownError(error));
        setLicensePhase("error");
      }
    };

    void loadLicenseStatus();
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
    if (licensePhase !== "valid") {
      clearAuthenticatedState();
      return;
    }

    const loadSessionStatus = async () => {
      try {
        const status = await invoke<SessionStatus>("get_session_status");
        setSessionStatus(status);
        setAuthPhase(status.authenticated ? "authenticated" : "anonymous");
        setAuthError(null);

        if (status.authenticated) {
          const user = await invoke<CurrentUser>("get_current_user");
          setCurrentUser(user);
          setAuthEmail(user.email);
        } else {
          setCurrentUser(null);
        }
      } catch (error) {
        setAuthError(formatUnknownError(error));
        setAuthPhase("error");
      }
    };

    void loadSessionStatus();
  }, [licensePhase]);

  useEffect(() => {
    if (licensePhase !== "valid" || authPhase !== "authenticated") {
      return;
    }

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
  }, [authPhase, licensePhase]);

  useEffect(() => {
    if (licensePhase !== "valid" || authPhase !== "authenticated") {
      return;
    }

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
  }, [authPhase, licensePhase]);

  useEffect(() => {
    if (licensePhase !== "valid" || authPhase !== "authenticated") {
      return;
    }

    const loadSystemPromptSettings = async () => {
      try {
        const settings = await invoke<SystemPromptSettings>(
          "get_system_prompt_settings",
        );
        setSystemPromptSettings(settings);
        setSystemPromptDraft(settings.customPrompt);
      } catch (error) {
        setAppError(formatUnknownError(error));
      } finally {
        setLoadingSystemPrompt(false);
      }
    };

    const loadHistory = async () => {
      setLoadingHistory(true);
      try {
        const summaries = await invoke<ConversationSummary[]>("get_conversation_summaries");
        setConversations(summaries);
      } catch (error) {
        setAppError(formatUnknownError(error));
      } finally {
        setLoadingHistory(false);
      }
    };

    void loadSystemPromptSettings();
    void loadHistory();
  }, [authPhase, licensePhase]);

  const refreshDingtalkStatus = async () => {
    try {
      const status = await invoke<DingTalkStatus>("get_dingtalk_status");
      setDingtalkStatus(status);
    } catch (error) {
      setAppError(formatUnknownError(error));
    }
  };

  useEffect(() => {
    if (licensePhase !== "valid" || authPhase !== "authenticated") {
      return;
    }

    void refreshDingtalkStatus();
  }, [authPhase, licensePhase]);

  useEffect(() => {
    if (licensePhase !== "valid" || authPhase !== "authenticated") {
      return;
    }

    const interval = window.setInterval(() => {
      void refreshDingtalkStatus();
    }, activePanel === "dingtalk" || dingtalkStatus?.running ? 5000 : 15000);

    return () => window.clearInterval(interval);
  }, [
    activePanel,
    authPhase,
    dingtalkStatus?.running,
    licensePhase,
  ]);

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
  const refreshLicenseStatus = async () => {
    try {
      const status = await invoke<LicenseStatus>("get_license_status");
      setLicenseStatus(status);
      setLicensePhase(status.valid ? "valid" : "missing");
      setLicenseError(null);
    } catch (error) {
      setLicenseError(formatUnknownError(error));
      setLicensePhase("error");
    }
  };

  const refreshSessionStatus = async () => {
    try {
      const status = await invoke<SessionStatus>("get_session_status");
      setSessionStatus(status);
      setAuthPhase(status.authenticated ? "authenticated" : "anonymous");
      setAuthError(null);

      if (status.authenticated) {
        const user = await invoke<CurrentUser>("get_current_user");
        setCurrentUser(user);
        setAuthEmail(user.email);
      } else {
        setCurrentUser(null);
      }
    } catch (error) {
      setAuthError(formatUnknownError(error));
      setAuthPhase("error");
    }
  };

  const openLicensePicker = () => {
    licenseInputRef.current?.click();
  };

  const clearLocalLicense = async () => {
    setLicenseBusy(true);

    try {
      const status = await invoke<LicenseStatus>("clear_license");
      setLicenseStatus(status);
      setLicensePhase("missing");
      setLicenseError(null);
      clearAuthenticatedState();
    } catch (error) {
      setLicenseError(formatUnknownError(error));
      setLicensePhase("error");
    } finally {
      setLicenseBusy(false);
    }
  };

  const handleLicenseImport = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    setLicenseBusy(true);

    try {
      const contents = await file.text();
      const result = await invoke<ImportLicenseResult>("import_license", {
        request: {
          fileName: file.name,
          contents,
        } satisfies ImportLicenseRequest,
      });

      setLicenseStatus(result.status);
      setLicensePhase(result.valid ? "valid" : "missing");
      setLicenseError(null);
      setAuthPhase("checking");
    } catch (error) {
      setLicenseError(formatUnknownError(error));
      await refreshLicenseStatus();
    } finally {
      event.target.value = "";
      setLicenseBusy(false);
    }
  };

  const handleAuthSubmit = async () => {
    if (!authEmail.trim() || !authPassword.trim()) {
      return;
    }

    setAuthBusy(true);
    setAuthError(null);

    try {
      if (authMode === "register") {
        const status = await invoke<SessionStatus>("register_account", {
          request: {
            email: authEmail,
            password: authPassword,
          } satisfies RegisterAccountRequest,
        });
        setSessionStatus(status);
        setAuthMode("login");
      } else {
        const status = await invoke<SessionStatus>("login", {
          request: {
            email: authEmail,
            password: authPassword,
          } satisfies LoginRequest,
        });
        setSessionStatus(status);
        setAuthPhase(status.authenticated ? "authenticated" : "anonymous");
        if (status.authenticated) {
          const user = await invoke<CurrentUser>("get_current_user");
          setCurrentUser(user);
          setAuthEmail(user.email);
          setAuthPassword("");
        }
      }
    } catch (error) {
      setAuthError(formatUnknownError(error));
      await refreshSessionStatus();
    } finally {
      setAuthBusy(false);
    }
  };

  const handleLogout = async () => {
    setAuthBusy(true);

    try {
      const status = await invoke<SessionStatus>("logout");
      setSessionStatus(status);
      setAuthPhase("anonymous");
      setAuthPassword("");
      clearAuthenticatedState();
    } catch (error) {
      setAuthError(formatUnknownError(error));
    } finally {
      setAuthBusy(false);
    }
  };

  const canSend =
    (Boolean(input.trim()) || pendingAttachments.length > 0) &&
    !running &&
    !loadingStatuses &&
    Boolean(activeStatus?.configured);
  const systemPromptDirty =
    systemPromptDraft !== (systemPromptSettings?.customPrompt ?? "");
  const resolvedAppearance: Exclude<AppearanceMode, "system"> =
    appearanceMode === "system"
      ? systemPrefersDark
        ? "dark"
        : "light"
      : appearanceMode;
  const isQclawLight = resolvedAppearance === "light";
  const appearanceModeLabel =
    appearanceMode === "light"
      ? "浅色"
      : appearanceMode === "dark"
        ? "深色"
        : `跟随系统（当前${resolvedAppearance === "dark" ? "深色" : "浅色"}）`;

  const activePanelTitle =
    activePanel === "chat"
      ? "对话"
      : activePanel === "skills"
        ? "技能"
        : activePanel === "dingtalk"
          ? "钉钉中继"
          : "系统提示词设置";

  const activePanelStatusText =
    activePanel === "chat"
      ? runtimeNotice
      : activePanel === "skills"
        ? loadingSkills
          ? "正在加载技能..."
          : `已加载 ${skills.length} 个技能`
        : activePanel === "dingtalk"
          ? dingtalkBusy
            ? "正在同步中继状态..."
            : dingtalkStatus?.message ?? "中继状态已就绪"
          : loadingSystemPrompt
            ? "正在加载系统提示词设置..."
            : savingSystemPrompt
              ? "正在保存系统提示词设置..."
              : systemPromptDirty
                ? "有未保存的更改"
                : "系统提示词设置已就绪";

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

  if (licensePhase !== "valid") {
    return (
      <ConfigProvider
        theme={{
          token: {
            colorPrimary: "#3b82f6",
            borderRadius: 18,
            fontFamily: '"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',
          },
        }}
      >
        <input
          ref={licenseInputRef}
          type="file"
          accept=".json,.license,.lic,.dat,text/plain,application/json"
          onChange={handleLicenseImport}
          style={{ display: "none" }}
        />
        <ActivationScreen
          phase={licensePhase}
          status={licenseStatus}
          licenseBusy={licenseBusy}
          licenseError={licenseError}
          onImportClick={openLicensePicker}
          onRefresh={() => void refreshLicenseStatus()}
          onClear={() => void clearLocalLicense()}
        />
      </ConfigProvider>
    );
  }

  if (authPhase !== "authenticated") {
    return (
      <ConfigProvider
        theme={{
          token: {
            colorPrimary: "#3b82f6",
            borderRadius: 18,
            fontFamily: '"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',
          },
        }}
      >
        <AuthScreen
          mode={authMode}
          email={authEmail}
          password={authPassword}
          busy={authBusy}
          sessionStatus={sessionStatus}
          authError={authError}
          onModeChange={setAuthMode}
          onEmailChange={setAuthEmail}
          onPasswordChange={setAuthPassword}
          onSubmit={() => void handleAuthSubmit()}
        />
      </ConfigProvider>
    );
  }

  const toggleMode = () => {
    setMode((current) => (current === "online" ? "local" : "online"));
    setAppError(null);
  };

  const startDingtalkBot = async () => {
    setDingtalkBusy(true);
    try {
      const status = await invoke<DingTalkStatus>("start_dingtalk_bot");
      setDingtalkStatus(status);
      setDingtalkOpen(true);
      setAppError(null);
    } catch (error) {
      setAppError(formatUnknownError(error));
    } finally {
      setDingtalkBusy(false);
    }
  };

  const stopDingtalkBot = async () => {
    setDingtalkBusy(true);
    try {
      const status = await invoke<DingTalkStatus>("stop_dingtalk_bot");
      setDingtalkStatus(status);
      setAppError(null);
    } catch (error) {
      setAppError(formatUnknownError(error));
    } finally {
      setDingtalkBusy(false);
    }
  };

  const refreshSystemPromptSettings = async () => {
    setLoadingSystemPrompt(true);
    try {
      const settings = await invoke<SystemPromptSettings>("get_system_prompt_settings");
      setSystemPromptSettings(settings);
      setSystemPromptDraft(settings.customPrompt);
      setAppError(null);
    } catch (error) {
      setAppError(formatUnknownError(error));
    } finally {
      setLoadingSystemPrompt(false);
    }
  };

  const saveSystemPromptSettings = async () => {
    setSavingSystemPrompt(true);
    try {
      const settings = await invoke<SystemPromptSettings>(
        "update_system_prompt_settings",
        {
          request: {
            customPrompt: systemPromptDraft,
          } satisfies UpdateSystemPromptSettingsRequest,
        },
      );
      setSystemPromptSettings(settings);
      setSystemPromptDraft(settings.customPrompt);
      setAppError(null);
    } catch (error) {
      setAppError(formatUnknownError(error));
    } finally {
      setSavingSystemPrompt(false);
    }
  };

  const resetSystemPromptSettings = async () => {
    setSystemPromptDraft("");
    setSavingSystemPrompt(true);
    try {
      const settings = await invoke<SystemPromptSettings>(
        "update_system_prompt_settings",
        {
          request: {
            customPrompt: "",
          } satisfies UpdateSystemPromptSettingsRequest,
        },
      );
      setSystemPromptSettings(settings);
      setSystemPromptDraft(settings.customPrompt);
      setAppError(null);
    } catch (error) {
      setAppError(formatUnknownError(error));
    } finally {
      setSavingSystemPrompt(false);
    }
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

  const handleTerminalDirectExecutionToggle = async (enabled: boolean) => {
    const skillId = "execute-terminal-command";
    setUpdatingSkillIds((current) => [...new Set([...current, skillId])]);

    try {
      const updatedSkill = await invoke<SkillSummary>(
        "update_skill_requires_confirmation",
        {
          request: {
            skillId,
            requiresConfirmation: !enabled,
          } satisfies UpdateSkillRequiresConfirmationRequest,
        },
      );

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

        let allowed = terminalCommandDirectExecutionEnabled;
        if (terminalCommandDirectExecutionEnabled) {
          setMessages((current) => [
            ...current,
            createUiMessage(
              "tool-call",
              "终端命令",
              `已按当前配置直接执行以下命令：\n\n${command}`,
            ),
          ]);
          setRuntimeNotice(`正在按当前配置直接执行终端命令：${command}`);
        } else {

        setMessages((current) => [
          ...current,
          createUiMessage(
            "tool-call",
            "安全确认",
            `AI 请求执行以下命令：\n\n${command}`,
          ),
        ]);
        setRuntimeNotice("等待你确认执行终端命令...");

        allowed = await requestCommandApproval(command);
        }
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
            "网页搜索",
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
        setRuntimeNotice(`正在进行网页搜索：${query}`);

        try {
          const output = await invoke<string>("run_duckduckgo_search", {
            request: {
              query,
              maxResults,
            } satisfies RunDuckDuckGoSearchRequest,
          });
          const toolOutput = output.trim()
            ? output
            : "(网页搜索成功，但没有返回结果)";

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
          const toolOutput = `网页搜索失败：\n${formatUnknownError(error)}`;

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
            `资源 ID：${assetId}${task ? `\n任务：${task}` : ""}\n文字识别：${
              ocr ? "是" : "否"
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
            `资源 ID：${assetId}${
              language ? `\n语言：${language}` : ""
            }${prompt ? `\n提示词：${prompt}` : ""}`,
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
    setActiveConversationId(null);
  };

  const handleSelectConversation = async (conversationId: string) => {
    if (running) return;
    try {
      const msgs = await invoke<ConversationMessage[]>("get_conversation_messages", {
        request: { conversationId } satisfies ConversationMessagesRequest
      });
      
      const summary = conversations.find(c => c.id === conversationId);
      if (summary) setMode(summary.mode);

      // Reconstruct UI messages
      const uiMessages: UiMessage[] = [];
      msgs.forEach(msg => {
        if (msg.role === "user") {
          uiMessages.push(createUiMessage("user", "你", msg.content || ""));
        } else if (msg.role === "assistant") {
          if (msg.content) {
            uiMessages.push(createUiMessage("assistant", "助手", msg.content));
          }
          if (msg.toolCalls && msg.toolCalls.length > 0) {
            for (const call of msg.toolCalls) {
              uiMessages.push(createUiMessage("tool-call", "工具调用", call.function.name + "\n" + call.function.arguments));
            }
          }
        } else if (msg.role === "tool") {
          uiMessages.push(createUiMessage("tool-result", "终端结果", msg.content || ""));
        }
      });
      
      messagesRef.current.forEach(m => releaseAttachmentPreviews(m.attachments));
      setMessages(uiMessages);
      resetPendingAttachments();
      conversationRef.current = msgs;
      currentAssistantMessageIdRef.current = null;
      setActiveConversationId(conversationId);
      setActivePanel("chat");
      setRuntimeNotice("已加载历史会话");
    } catch (error) {
      setAppError(formatUnknownError(error));
    }
  };

  const handleDeleteConversation = async (conversationId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    try {
      await invoke("delete_conversation", {
        request: { conversationId } satisfies DeleteConversationRequest
      });
      setConversations(prev => prev.filter(c => c.id !== conversationId));
      if (activeConversationId === conversationId) {
        resetConversation();
      }
    } catch (error) {
      setAppError(formatUnknownError(error));
    }
  };

  const persistMessages = async (id: string, msgs: ConversationMessage[]) => {
    try {
      const summary = await invoke<ConversationSummary>("append_conversation_messages", {
        request: {
          conversationId: id,
          messages: msgs,
          mode,
        } satisfies AppendConversationMessagesRequest
      });
      setConversations(prev => prev.map(c => c.id === id ? summary : c));
    } catch(e) {
      console.error("Failed to append messages", e);
    }
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

    let currentConversationId = activeConversationId;
    try {
      if (!currentConversationId) {
        const summary = await invoke<ConversationSummary>("create_conversation", {
          request: { mode, title: displayPrompt } satisfies CreateConversationRequest
        });
        currentConversationId = summary.id;
        setActiveConversationId(summary.id);
        setConversations(prev => [summary, ...prev]);
      }
      
      const userMessage: ConversationMessage = {
        role: "user",
        content: finalPrompt,
      };
      
      await persistMessages(currentConversationId, [userMessage]);
    } catch(e) {
      setAppError(formatUnknownError(e));
      setRuntimeNotice("开始会话失败");
      setRunning(false);
      return;
    }

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
        await persistMessages(currentConversationId, normalizedMessages);

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
          if (toolCall.function.name !== "execute_terminal_command") {
            const toolOutput = await executeToolCall(toolCall, streamId);
            const toolMsg: ConversationMessage = {
              role: "tool",
              content: toolOutput,
              toolCallId: toolCall.id,
            };

            currentConversation = [
              ...currentConversation,
              toolMsg,
            ];
            conversationRef.current = currentConversation;
            await persistMessages(currentConversationId, [toolMsg]);
            setRuntimeNotice(
              `已将 ${toolCall.function.name} 的结果回传给模型，继续推理...`,
            );
            continue;
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

          const terminalToolMsg: ConversationMessage = {
            role: "tool",
            content: toolOutput,
            toolCallId: toolCall.id,
          };
          currentConversation = [
            ...currentConversation,
            terminalToolMsg,
          ];
          conversationRef.current = currentConversation;
          await persistMessages(currentConversationId, [terminalToolMsg]);
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
        algorithm:
          resolvedAppearance === "dark"
            ? antdTheme.darkAlgorithm
            : antdTheme.defaultAlgorithm,
        token: {
          colorPrimary: isQclawLight ? "#2f86ff" : "#1677ff",
          colorTextBase: isQclawLight ? "#111827" : "#f8fafc",
          colorBgBase: isQclawLight ? "#ffffff" : "#0b1120",
          colorBorder: isQclawLight ? "#e5e7eb" : "rgba(255,255,255,0.08)",
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
            itemSelectedBg: isQclawLight ? "#e6efff" : "rgba(255,255,255,0.12)",
            itemHoverBg: isQclawLight ? "#f1f5f9" : "rgba(255,255,255,0.08)",
            trackBg: isQclawLight ? "#f3f4f6" : "rgba(255,255,255,0.04)",
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
          background: isQclawLight
            ? "linear-gradient(180deg, #f5f5f6 0%, #f0f1f3 100%)"
            : "radial-gradient(circle at top, rgba(59,130,246,0.18), transparent 26%), linear-gradient(180deg, #080b12 0%, #0b0f17 52%, #0d1118 100%)",
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
            width={260}
            style={{ background: "transparent" }}
          >
            <div
              style={{
                display: "flex",
                height: "100%",
                overflow: "hidden",
                borderRadius: 28,
                background: isQclawLight ? "#f8fafc" : "#1e1e1e",
                border: isQclawLight ? "1px solid #e5e7eb" : "1px solid rgba(255,255,255,0.08)"
              }}
            >
              {/* 极简侧边栏 */}
              <div
                style={{
                  width: 68,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  padding: "20px 0",
                  background: isQclawLight ? "#f1f2f4" : "#151515"
                }}
              >
                {/* 头像 */}
                <div
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: "50%",
                    background: "#475569",
                    color: "#fff",
                    display: "flex",
                    justifyContent: "center",
                    alignItems: "center",
                    fontWeight: "bold",
                    overflow: "hidden"
                  }}
                >
                  <img src={avatarImg} alt="avatar" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                </div>

                {/* 顶部菜单：对话 */}
                <div style={{ flex: 1, marginTop: 32 }}>
                  <div
                    onClick={() => setActivePanel("chat")}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      cursor: "pointer",
                      color: activePanel === "chat" ? (isQclawLight ? "#2563eb" : "#dbeafe") : "#64748b"
                    }}
                  >
                    <MessageOutlined style={{ fontSize: 20 }} />
                    <Text style={{ fontSize: 12, marginTop: 4, color: "inherit" }}>对话</Text>
                  </div>
                </div>

                {/* 底部菜单：手机与设置 */}
                <Space direction="vertical" size={24} style={{ marginBottom: 12 }}>
                  <div
                    onClick={() => setDingtalkOpen(true)}
                    style={{
                      cursor: "pointer",
                      textAlign: "center",
                      color: dingtalkOpen ? (isQclawLight ? "#2563eb" : "#dbeafe") : "#64748b"
                    }}
                  >
                    <MobileOutlined style={{ fontSize: 20 }} />
                  </div>
                  <div
                    onClick={() => setSettingsOpen(true)}
                    style={{
                      cursor: "pointer",
                      textAlign: "center",
                      color: "#64748b"
                    }}
                  >
                    <SettingOutlined style={{ fontSize: 20 }} />
                  </div>
                </Space>
              </div>

              {/* 二级侧边栏（新建 Agent / 历史记录） */}
              <div
                style={{
                  flex: 1,
                  padding: 16,
                  display: "flex",
                  flexDirection: "column",
                  overflow: "hidden"
                }}
              >
                <div style={{ flex: 1, overflow: "hidden", paddingBottom: 16 }}>
                  <ConversationList
                    conversations={conversations}
                    activeConversationId={activeConversationId}
                    loading={loadingHistory}
                    isLight={isQclawLight}
                    onSelect={handleSelectConversation}
                    onDelete={handleDeleteConversation}
                    onNew={resetConversation}
                  />
                </div>

                <div
                  style={{
                    flexShrink: 0,
                    paddingTop: 16,
                    borderTop: isQclawLight ? "1px solid #e5e7eb" : "1px solid rgba(255,255,255,0.08)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <Space size={8} align="center">
                    {statusDot}
                    <Text style={{ color: isQclawLight ? "#374151" : "#cbd5e1", fontSize: 12 }}>
                      后端状态
                    </Text>
                  </Space>
                  <Text
                    style={{
                      color: loadingStatuses
                        ? isQclawLight
                          ? "#6b7280"
                          : "#94a3b8"
                        : activeStatus?.configured
                          ? "#22c55e"
                          : "#f87171",
                      fontSize: 12,
                      letterSpacing: 1.1,
                    }}
                  >
                    {loadingStatuses
                      ? "加载中"
                      : activeStatus?.configured
                        ? "就绪"
                        : "错误"}
                  </Text>
                </div>
              </div>
            </div>
          </Sider>

          <Content
            style={{
              minWidth: 0,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
              background: isQclawLight ? "#f7f7f8" : "rgba(255,255,255,0.035)",
              border: isQclawLight
                ? "1px solid #e5e7eb"
                : "1px solid rgba(255,255,255,0.08)",
              borderRadius: 28,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                padding: "20px 28px 18px",
                borderBottom: isQclawLight
                  ? "1px solid #e5e7eb"
                  : "1px solid rgba(255,255,255,0.08)",
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
                    style={{
                      margin: 0,
                      color: isQclawLight ? "#111827" : "#f8fafc",
                      fontWeight: 600,
                    }}
                  >
                    {activePanel === "chat" ? "对话与执行流" : "技能列表"}
                  </Title>
                </div>
                <div
                  style={{
                    borderRadius: 999,
                    border: isQclawLight
                      ? "1px solid #e5e7eb"
                      : "1px solid rgba(255,255,255,0.08)",
                    background: isQclawLight ? "#f8fafc" : "rgba(5,10,18,0.55)",
                    padding: "8px 14px",
                    minWidth: 160,
                    textAlign: "center",
                  }}
                >
                  <Text style={{ color: isQclawLight ? "#374151" : "#cbd5e1", fontSize: 13 }}>
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
                      background: isQclawLight ? "#fef2f2" : "rgba(127,29,29,0.25)",
                      border: isQclawLight
                        ? "1px solid #fecaca"
                        : "1px solid rgba(248,113,113,0.2)",
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
                        <div style={{ paddingTop: 72 }}>
                          <Title
                            level={1}
                            style={{
                              margin: 0,
                              textAlign: "center",
                              fontSize: 52,
                              lineHeight: 1.05,
                              color: isQclawLight ? "#111827" : "#ffffff",
                            }}
                          >
                            Hi，我是HZCUClaw
                          </Title>
                          <Paragraph
                            style={{
                              marginTop: 10,
                              textAlign: "center",
                              color: isQclawLight ? "#9aa0a6" : "#a1a1aa",
                              fontSize: 40,
                              fontWeight: 600,
                            }}
                          >
                            随时随地，帮您高效干活
                          </Paragraph>
                          <div
                            style={{
                              marginTop: 30,
                              display: "grid",
                              gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
                              gap: 14,
                            }}
                          >
                            {[
                              { title: "安装你的第一个Skill", subtitle: "一键帮你安装超能力", color: isQclawLight ? "#efe9fb" : "#2e2840" },
                              { title: "邮件管理", subtitle: "帮你高效处理邮件", color: isQclawLight ? "#f8f1e8" : "#3f3523" },
                              { title: "整理桌面", subtitle: "还你清爽电脑桌面", color: isQclawLight ? "#edf4ec" : "#243029" },
                              { title: "安排日程", subtitle: "一句话约日程定会议", color: isQclawLight ? "#f9eff1" : "#3b2327" },
                              { title: "手机远程办公", subtitle: "随时处理在线任务", color: isQclawLight ? "#e9f1f9" : "#1f2e37" },
                            ].map((card) => (
                              <button
                                key={card.title}
                                type="button"
                                onClick={() => setInput(card.title)}
                                style={{
                                  border: isQclawLight ? "1px solid #e5e7eb" : "1px solid rgba(255,255,255,0.06)",
                                  borderRadius: 16,
                                  background: card.color,
                                  padding: "14px 14px 12px",
                                  textAlign: "left",
                                  cursor: "pointer",
                                  minHeight: 188,
                                  boxShadow: isQclawLight ? "none" : "0 4px 20px rgba(0,0,0,0.2)",
                                }}
                              >
                                <Text
                                  style={{
                                    display: "block",
                                    color: isQclawLight ? "#111827" : "#f8fafc",
                                    fontWeight: 600,
                                    marginTop: 8,
                                  }}
                                >
                                  {card.title}
                                </Text>
                                <Text
                                  style={{
                                    display: "block",
                                    color: isQclawLight ? "#6b7280" : "#94a3b8",
                                    fontSize: 12,
                                    marginTop: 4,
                                  }}
                                >
                                  {card.subtitle}
                                </Text>
                              </button>
                            ))}
                          </div>
                        </div>
                    ) : (
                      <Space
                        direction="vertical"
                        size={18}
                        style={{ display: "flex", width: "100%" }}
                      >
                        {messages.map((message) => {
                          const tone = getMessageTone(message.kind, isQclawLight);

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
                                      ? "输出中"
                                      : message.status === "error"
                                        ? "失败"
                                        : "完成"}
                                  </Text>
                                </div>
                                <MessageAttachments attachments={message.attachments} light={isQclawLight} />
                                {message.kind === "tool-result" ? (
                                  <div
                                    style={{
                                      marginTop: 2,
                                      maxHeight: 260,
                                      overflowY: "auto",
                                      borderRadius: 18,
                                      border: isQclawLight
                                        ? "1px solid #e5e7eb"
                                        : "1px solid rgba(255,255,255,0.08)",
                                      background: isQclawLight ? "#f8fafc" : "#020617",
                                      padding: "14px 16px",
                                    }}
                                  >
                                    <pre
                                      style={{
                                        margin: 0,
                                        whiteSpace: "pre-wrap",
                                        wordBreak: "break-word",
                                        color: isQclawLight ? "#1f2937" : "#dbeafe",
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
                                        color: isQclawLight ? "#111827" : "#f8fafc",
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
                    borderTop: isQclawLight
                      ? "1px solid #e5e7eb"
                      : "1px solid rgba(255,255,255,0.08)",
                    background: isQclawLight
                      ? "linear-gradient(180deg, rgba(248,250,252,0.65) 0%, rgba(255,255,255,0.95) 62%)"
                      : "linear-gradient(180deg, rgba(9,14,24,0.2) 0%, rgba(9,14,24,0.75) 38%, rgba(9,14,24,0.95) 100%)",
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
                          ? "1px solid #60a5fa"
                          : isQclawLight
                            ? "1px solid #e5e7eb"
                            : "1px solid rgba(255,255,255,0.08)",
                        background: dragActive
                          ? isQclawLight
                            ? "#eef5ff"
                            : "rgba(59,130,246,0.08)"
                          : isQclawLight
                            ? "#ffffff"
                            : "rgba(255,255,255,0.04)",
                        boxShadow: isQclawLight
                          ? "0 12px 30px rgba(15, 23, 42, 0.08)"
                          : "0 18px 60px rgba(0, 0, 0, 0.28)",
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
                        placeholder="请向 HZCUclaw 提问，例如：帮我检查当前目录结构并给出总结。"
                        disabled={running}
                        style={{
                          padding: 0,
                          color: isQclawLight ? "#111827" : "#f8fafc",
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
                                border: isQclawLight
                                  ? "1px solid #e5e7eb"
                                  : "1px solid rgba(255,255,255,0.08)",
                                background: isQclawLight ? "#f8fafc" : "rgba(2,6,23,0.6)",
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
                                      background: isQclawLight
                                        ? "rgba(148,163,184,0.22)"
                                        : "rgba(148,163,184,0.16)",
                                      color: isQclawLight ? "#4b5563" : "#cbd5e1",
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
                                      color: isQclawLight ? "#111827" : "#f8fafc",
                                      fontSize: 13,
                                    }}
                                    ellipsis
                                  >
                                    {attachment.file.name}
                                  </Text>
                                  <Text
                                    style={{
                                      color: isQclawLight ? "#6b7280" : "#94a3b8",
                                      fontSize: 12,
                                    }}
                                  >
                                    {attachment.kind === "image" ? "图片" : "音频"} ·{" "}
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
                            style={{ color: isQclawLight ? "#374151" : "#cbd5e1" }}
                          >
                            添加附件
                          </Button>
                          <Text style={{ color: isQclawLight ? "#6b7280" : "#94a3b8", fontSize: 13 }}>
                            按 Ctrl/Cmd + Enter 发送
                          </Text>
                          <Text style={{ color: isQclawLight ? "#9ca3af" : "#64748b", fontSize: 13 }}>
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
            ) : null}
          </Content>
        </Layout>

        {/* 手机端的钉钉中继悬浮窗 Modal */}
        <Modal
          open={dingtalkOpen}
          onCancel={() => setDingtalkOpen(false)}
          footer={null}
          width={760}
          styles={{ body: { padding: 0 } }}
          closable={true}
          centered
          destroyOnClose
        >
          <div
            style={{
              background: isQclawLight ? "#ffffff" : "#0f172a",
              borderRadius: 16,
              padding: "16px 36px 16px 0",
            }}
          >
            <div
              style={{
                padding: "24px 32px 24px 48px",
                maxHeight: "80vh",
                overflowY: "auto",
              }}
            >
              <div
                style={{
                  borderRadius: 24,
                  border: isQclawLight
                    ? "1px solid #e5e7eb"
                    : "1px solid rgba(255,255,255,0.08)",
                  background: isQclawLight ? "#f8fafc" : "rgba(255,255,255,0.03)",
                  padding: "22px 24px",
                  marginBottom: 22,
                }}
              >
              <Space
                size={16}
                style={{
                  width: "100%",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center"
                }}
              >
                <div>
                  <Text
                    style={{
                      display: "block",
                      color: isQclawLight ? "#111827" : "#f8fafc",
                      fontSize: 18,
                      fontWeight: 600,
                    }}
                  >
                    钉钉 Stream 模式
                  </Text>
                  <Paragraph
                    style={{
                      margin: "10px 0 0",
                      color: isQclawLight ? "#64748b" : "#94a3b8",
                      fontSize: 13,
                      lineHeight: 1.8,
                      maxWidth: 420,
                    }}
                  >
                    你可以在这里启动或停止本地钉钉中继。要实现远程对话和远程控制，桌面应用必须持续在线。
                  </Paragraph>
                </div>
                <Space wrap size={10}>
                  <Button
                    type="primary"
                    shape="round"
                    icon={dingtalkBusy ? <LoadingOutlined /> : <ApiOutlined />}
                    onClick={() => void startDingtalkBot()}
                    disabled={dingtalkBusy || dingtalkStatus?.running}
                  >
                    启动
                  </Button>
                  <Button
                    danger
                    shape="round"
                    onClick={() => void stopDingtalkBot()}
                    disabled={dingtalkBusy || !dingtalkStatus?.running}
                  >
                    停止
                  </Button>
                  <Button
                    shape="round"
                    onClick={() => void refreshDingtalkStatus()}
                    disabled={dingtalkBusy}
                  >
                    刷新
                  </Button>
                </Space>
              </Space>
            </div>

            {!dingtalkStatus?.configured ? (
              <Alert
                type="warning"
                showIcon
                message="钉钉中继尚未配置"
                description="请先在 .env 中设置 DINGTALK_CLIENT_ID 和 DINGTALK_CLIENT_SECRET，然后安装 Python 辅助依赖。"
                style={{ marginBottom: 18, borderRadius: 16 }}
              />
            ) : null}

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                gap: 14,
                marginBottom: 24,
              }}
            >
              {[
                {
                  label: "中继状态",
                  value: dingtalkStatus?.running ? "运行中" : "已停止",
                  color: dingtalkStatus?.running ? "#10b981" : "#ef4444",
                },
                {
                  label: "代理模式",
                  value: dingtalkStatus?.mode
                    ? MODE_LABELS[dingtalkStatus.mode]
                    : MODE_LABELS.online,
                  color: "#3b82f6",
                },
                {
                  label: "远程 /run",
                  value: dingtalkStatus?.remoteCommandsEnabled
                    ? "已开启"
                    : "已关闭",
                  color: dingtalkStatus?.remoteCommandsEnabled
                    ? "#f59e0b"
                    : (isQclawLight ? "#64748b" : "#94a3b8"),
                },
                {
                  label: "允许列表",
                  value: `${dingtalkStatus?.allowedSenderCount ?? 0} 个用户 / ${
                    dingtalkStatus?.allowedChatCount ?? 0
                  } 个群`,
                  color: isQclawLight ? "#475569" : "#cbd5e1",
                },
              ].map((item) => (
                <div
                  key={item.label}
                  style={{
                    borderRadius: 20,
                    border: isQclawLight ? "1px solid #e2e8f0" : "1px solid rgba(255,255,255,0.08)",
                    background: isQclawLight ? "#f8fafc" : "rgba(255,255,255,0.03)",
                    padding: "16px 20px",
                  }}
                >
                  <Text
                    style={{
                      display: "block",
                      color: isQclawLight ? "#64748b" : "#94a3b8",
                      fontSize: 12,
                      marginBottom: 8,
                    }}
                  >
                    {item.label}
                  </Text>
                  <Text style={{ color: item.color, fontSize: 16, fontWeight: 600 }}>
                    {item.value}
                  </Text>
                </div>
              ))}
            </div>

            <div
              style={{
                borderRadius: 24,
                border: isQclawLight ? "1px solid #e5e7eb" : "1px solid rgba(255,255,255,0.08)",
                background: isQclawLight ? "#f8fafc" : "rgba(255,255,255,0.03)",
                padding: 20,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  marginBottom: 16,
                }}
              >
                <Text
                  style={{
                    color: isQclawLight ? "#111827" : "#f8fafc",
                    fontSize: 16,
                    fontWeight: 600,
                  }}
                >
                  中继事件日志
                </Text>
                <Text style={{ color: isQclawLight ? "#64748b" : "#94a3b8", fontSize: 12 }}>
                  {dingtalkStatus?.events.length ?? 0} 条事件
                </Text>
              </div>

              {!dingtalkStatus?.events.length ? (
                <Text style={{ color: isQclawLight ? "#94a3b8" : "#64748b", fontSize: 13, display: "block", textAlign: "center", padding: "20px 0" }}>
                  暂无钉钉中继事件
                </Text>
              ) : (
                <Space direction="vertical" size={10} style={{ display: "flex" }}>
                  {[...dingtalkStatus.events]
                    .slice()
                    .reverse()
                    .map((event) => (
                      <div
                        key={`${event.timestamp}-${event.message}`}
                        style={{
                          borderRadius: 16,
                          border: isQclawLight ? "1px solid #e2e8f0" : "1px solid rgba(255,255,255,0.08)",
                          background: isQclawLight ? "#ffffff" : "rgba(2,6,23,0.5)",
                          padding: "12px 16px",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: 12,
                            marginBottom: 8,
                          }}
                        >
                          <Tag
                            color={
                              event.level === "error"
                                ? "red"
                                : event.level === "warn"
                                  ? "gold"
                                  : "blue"
                            }
                            style={{ marginInlineEnd: 0, borderRadius: 6 }}
                          >
                            {event.level === "error"
                              ? "错误"
                              : event.level === "warn"
                                ? "警告"
                                : "信息"}
                          </Tag>
                          <Text style={{ color: isQclawLight ? "#94a3b8" : "#64748b", fontSize: 12 }}>
                            {event.timestamp}
                          </Text>
                        </div>
                        <pre
                          style={{
                            margin: 0,
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                            color: isQclawLight ? "#334155" : "#dbeafe",
                            fontSize: 13,
                            lineHeight: 1.6,
                            fontFamily:
                              '"Cascadia Code","Consolas","SFMono-Regular",monospace',
                          }}
                        >
                          {event.message}
                        </pre>
                      </div>
                    ))}
                </Space>
              )}
            </div>
            </div>
          </div>
        </Modal>
        
        <Modal
          open={settingsOpen}
          onCancel={() => setSettingsOpen(false)}
          footer={null}
          width={860}
          styles={{ body: { padding: 0 } }}
          closable={true}
          centered
          destroyOnClose
        >
          <div style={{ display: "flex", height: 600, overflow: "hidden", borderRadius: 8 }}>
             {/* 设置弹窗左侧导航 */}
             <div style={{ width: 200, background: isQclawLight ? "#f8fafc" : "#18181b", padding: "32px 16px", flexShrink: 0 }}>
                 <Title level={4} style={{ marginBottom: 28, paddingLeft: 16, color: isQclawLight ? "#111827" : "#f8fafc" }}>设置</Title>
                 <Space direction="vertical" size={4} style={{ width: "100%" }}>
                     <Button type={settingsTab === "general" ? "primary" : "text"} block onClick={() => setSettingsTab("general")} style={{ textAlign: "left", height: 44, borderRadius: 12, display: "flex", alignItems: "center", background: settingsTab === "general" ? (isQclawLight ? "#f1f5f9" : "rgba(255,255,255,0.08)") : "transparent", color: settingsTab === "general" ? (isQclawLight ? "#0f172a" : "#f8fafc") : (isQclawLight ? "#64748b" : "#94a3b8") }}><SettingOutlined />通用设置</Button>
                     <Button type={settingsTab === "usage" ? "primary" : "text"} block onClick={() => setSettingsTab("usage")} style={{ textAlign: "left", height: 44, borderRadius: 12, display: "flex", alignItems: "center", background: settingsTab === "usage" ? (isQclawLight ? "#f1f5f9" : "rgba(255,255,255,0.08)") : "transparent", color: settingsTab === "usage" ? (isQclawLight ? "#0f172a" : "#f8fafc") : (isQclawLight ? "#64748b" : "#94a3b8") }}><DesktopOutlined />用量统计</Button>
                     <Button type={settingsTab === "skills" ? "primary" : "text"} block onClick={() => setSettingsTab("skills")} style={{ textAlign: "left", height: 44, borderRadius: 12, display: "flex", alignItems: "center", background: settingsTab === "skills" ? (isQclawLight ? "#f1f5f9" : "rgba(255,255,255,0.08)") : "transparent", color: settingsTab === "skills" ? (isQclawLight ? "#0f172a" : "#f8fafc") : (isQclawLight ? "#64748b" : "#94a3b8") }}><AppstoreOutlined />技能管理</Button>
                     <Button type={settingsTab === "prompt" ? "primary" : "text"} block onClick={() => setSettingsTab("prompt")} style={{ textAlign: "left", height: 44, borderRadius: 12, display: "flex", alignItems: "center", background: settingsTab === "prompt" ? (isQclawLight ? "#f1f5f9" : "rgba(255,255,255,0.08)") : "transparent", color: settingsTab === "prompt" ? (isQclawLight ? "#0f172a" : "#f8fafc") : (isQclawLight ? "#64748b" : "#94a3b8") }}><FileTextOutlined />提示词配置</Button>
                 </Space>
             </div>
             {/* 设置弹窗右侧内容 */}
             <div style={{ flex: 1, background: isQclawLight ? "#fff" : "#0f172a", padding: "16px 36px 16px 0" }}>
                 <div style={{ height: "100%", padding: "16px 24px 16px 40px", overflowY: "auto" }}>
                 {settingsTab === "general" && (
                    <div>
                       <Title level={4} style={{ marginBottom: 32, color: isQclawLight ? "#111827" : "#f8fafc" }}>通用设置</Title>
                       
                       <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 0", borderBottom: isQclawLight ? "1px solid #f1f5f9" : "1px solid rgba(255,255,255,0.08)" }}>
                           <Text style={{ fontWeight: 600, color: isQclawLight ? "#0f172a" : "#f8fafc" }}>账号与邮箱</Text>
                           <Text style={{ color: isQclawLight ? "#64748b" : "#94a3b8" }}>{currentUser?.email || "未登录"}</Text>
                       </div>

                       <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 0", borderBottom: isQclawLight ? "1px solid #f1f5f9" : "1px solid rgba(255,255,255,0.08)" }}>
                           <Text style={{ fontWeight: 600, color: isQclawLight ? "#0f172a" : "#f8fafc" }}>外观模式</Text>
                           <Segmented
                             value={appearanceMode}
                             onChange={(value) => setAppearanceMode(value as AppearanceMode)}
                             options={[
                               { label: "浅色", value: "light" },
                               { label: "深色", value: "dark" },
                               { label: "跟随系统", value: "system" },
                             ]}
                           />
                       </div>

                       <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 0", borderBottom: isQclawLight ? "1px solid #f1f5f9" : "1px solid rgba(255,255,255,0.08)" }}>
                           <Text style={{ fontWeight: 600, color: isQclawLight ? "#0f172a" : "#f8fafc" }}>工作模式</Text>
                           <Segmented
                             value={mode}
                             onChange={(value) => setMode(value as AgentMode)}
                             options={[
                               { label: "连线", value: "online" },
                               { label: "本地", value: "local" },
                             ]}
                           />
                       </div>
                       
                       <Button block danger size="large" style={{ marginTop: 40, borderRadius: 14 }} onClick={() => void handleLogout()}>
                          退出登录
                       </Button>
                    </div>
                 )}
                 {settingsTab === "usage" && (
                    <div>
                       <Title level={4} style={{ marginBottom: 32, color: isQclawLight ? "#111827" : "#f8fafc" }}>用量统计</Title>
                       <Empty description="暂无用量统计数据" />
                    </div>
                 )}
                 {settingsTab === "skills" && (
                    <div style={{ paddingBottom: 24 }}>
                       <Space size={16} style={{ width: "100%", justifyContent: "space-between", marginBottom: 24 }}>
                           <Title level={4} style={{ margin: 0, color: isQclawLight ? "#111827" : "#f8fafc" }}>技能管理</Title>
                           <Text style={{ color: "#3b82f6" }}>{loadingSkills ? "读取中" : `${skills.length} 个技能`}</Text>
                       </Space>
                       
                       {loadingSkills ? (
                         <div style={{ padding: "40px 0", textAlign: "center" }}><Spin indicator={<LoadingOutlined spin />} /></div>
                       ) : skills.length === 0 ? (
                         <Empty description="当前未检测到任何技能" />
                       ) : (
                         <Space direction="vertical" size={16} style={{ display: "flex" }}>
                            {skills.map((skill) => {
                               const updating = updatingSkillIds.includes(skill.id);
                               return (
                                  <div key={skill.id} style={{ borderRadius: 20, border: isQclawLight ? "1px solid #e2e8f0" : "1px solid rgba(255,255,255,0.08)", background: isQclawLight ? "#f8fafc" : "rgba(255,255,255,0.02)", padding: 20 }}>
                                     <div style={{ display: "flex", justifyContent: "space-between" }}>
                                        <div style={{ minWidth: 0, paddingRight: 16 }}>
                                           <Text style={{ color: isQclawLight ? "#0f172a" : "#f8fafc", fontSize: 16, fontWeight: 600 }}>{skill.name}</Text>
                                           <div style={{ marginTop: 8 }}>
                                              <Space wrap size={[6, 6]}>
                                                <Tag color={skill.skillType === "tool" ? "blue" : "purple"}>{skill.skillType === "tool" ? "工具" : "提示词"}</Tag>
                                                <Tag color={skill.enabled ? "green" : "red"}>{skill.enabled ? "已启用" : "已停用"}</Tag>
                                              </Space>
                                           </div>
                                           <Paragraph style={{ margin: "10px 0 0", color: isQclawLight ? "#64748b" : "#94a3b8", fontSize: 13, lineHeight: 1.6 }}>{skill.description}</Paragraph>
                                           {skill.id === "execute-terminal-command" ? (
                                              <div style={{ marginTop: 12, padding: "12px", borderRadius: 14, background: isQclawLight ? "#e2e8f0" : "rgba(15,23,42,0.5)" }}>
                                                 <Space style={{ display: "flex", justifyContent: "space-between" }}>
                                                    <Text style={{ fontSize: 13, color: isQclawLight ? "#334155" : "#cbd5e1" }}>不审核直接运行终端命令？</Text>
                                                    <Switch size="small" checked={!skill.requiresConfirmation} loading={updating} onChange={(checked) => void handleTerminalDirectExecutionToggle(checked)} />
                                                 </Space>
                                              </div>
                                           ) : null}
                                        </div>
                                        <div style={{ flexShrink: 0 }}>
                                           <Switch checked={skill.enabled} loading={updating} onChange={(checked) => void handleSkillToggle(skill.id, checked)} />
                                        </div>
                                     </div>
                                  </div>
                               );
                            })}
                         </Space>
                       )}
                    </div>
                 )}
                 {settingsTab === "prompt" && (
                    <div>
                       <Space size={16} style={{ width: "100%", justifyContent: "space-between", marginBottom: 24 }}>
                           <Title level={4} style={{ margin: 0, color: isQclawLight ? "#111827" : "#f8fafc" }}>系统提示词配置</Title>
                           <Space size={8}>
                               <Button size="small" onClick={() => void refreshSystemPromptSettings()} disabled={loadingSystemPrompt || savingSystemPrompt}>重载</Button>
                               <Button type="primary" size="small" onClick={() => void saveSystemPromptSettings()} disabled={loadingSystemPrompt || savingSystemPrompt || !systemPromptDirty}>保存</Button>
                           </Space>
                       </Space>
                       <Paragraph style={{ color: isQclawLight ? "#64748b" : "#94a3b8", fontSize: 13 }}>留空时仅使用内置系统提示词与技能。此段内容会追加在运行时环境提示词之后。</Paragraph>
                       <TextArea value={systemPromptDraft} onChange={(e) => setSystemPromptDraft(e.target.value)} autoSize={{ minRows: 10, maxRows: 20 }} placeholder="自定义指令..." style={{ borderRadius: 16, background: isQclawLight ? "#f8fafc" : "rgba(2,6,23,0.72)", padding: 14, border: isQclawLight ? "1px solid #e2e8f0" : "1px solid rgba(255,255,255,0.08)", color: isQclawLight ? "#0f172a" : "#f8fafc" }} />
                    </div>
                 )}
                 </div>
             </div>
          </div>
        </Modal>

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

function buttonGhostStyle(light: boolean) {
  return {
    justifyContent: "flex-start" as const,
    height: 44,
    borderRadius: 16,
    border: light ? "1px solid #e5e7eb" : "1px solid rgba(255,255,255,0.08)",
    background: light ? "#f8fafc" : "rgba(255,255,255,0.03)",
    color: light ? "#374151" : "#e2e8f0",
    boxShadow: "none",
  };
}

function navButtonStyle(active: boolean, light: boolean) {
  return {
    justifyContent: "flex-start" as const,
    height: 46,
    borderRadius: 16,
    border: light
      ? active
        ? "1px solid #8cb5ff"
        : "1px solid #e5e7eb"
      : active
        ? "1px solid rgba(59,130,246,0.35)"
        : "1px solid rgba(255,255,255,0.06)",
    background: light
      ? active
        ? "#e8f1ff"
        : "#ffffff"
      : active
        ? "rgba(59,130,246,0.18)"
        : "rgba(255,255,255,0.03)",
    color: light ? (active ? "#2563eb" : "#374151") : active ? "#dbeafe" : "#cbd5e1",
    boxShadow: "none",
  };
}
