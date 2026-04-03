// 应用主界面组件。
// 这个版本使用接近“侧栏 + 主对话区 + 底部输入框”的布局模式：
// 1. 左侧是模式切换和状态指示
// 2. 中间是单独滚动的聊天区域
// 3. 底部输入框固定在聊天区底部，不随页面整体增长
import {
  ApiOutlined,
  CheckCircleFilled,
  DesktopOutlined,
  LoadingOutlined,
  MessageOutlined,
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
  Segmented,
  Space,
  Typography,
} from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  MODE_DESCRIPTIONS,
  MODE_LABELS,
  STREAM_EVENT_NAME,
  createClientId,
  formatUnknownError,
  type AgentMode,
  type AgentStreamEvent,
  type BackendModeStatuses,
  type ConversationMessage,
  type RunAgentTurnRequest,
  type RunAgentTurnResult,
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

interface UiMessage {
  id: string;
  kind: UiMessageKind;
  title: string;
  content: string;
  status: UiMessageStatus;
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
): UiMessage {
  return {
    id: createClientId(kind),
    kind,
    title,
    content,
    status,
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

  // conversationRef 保存真正传给后端模型代理的对话历史。
  const conversationRef = useRef<ConversationMessage[]>([]);
  const activeStreamIdRef = useRef<string | null>(null);
  const currentAssistantMessageIdRef = useRef<string | null>(null);
  const messageScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = messageScrollRef.current;

    if (!container) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      container.scrollTo({
        top: container.scrollHeight,
        behavior: "auto",
      });
    });

    return () => cancelAnimationFrame(frame);
  }, [messages, runtimeNotice]);

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
              const toolName =
                readEventField<string>(payload, "toolName", "tool_name") ?? "";
              const command =
                readEventField<string>(payload, "command", "command") ?? "";
              setMessages((current) => [
                ...current,
                createUiMessage(
                  "tool-call",
                  "工具调用",
                  `${toolName}\n\ncommand: ${command}`,
                ),
              ]);
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
    Boolean(input.trim()) &&
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

  const toggleMode = () => {
    setMode((current) => (current === "online" ? "local" : "online"));
    setAppError(null);
  };

  const resetConversation = () => {
    setMessages([]);
    setAppError(null);
    setRuntimeNotice("等待你输入需求");
    conversationRef.current = [];
    currentAssistantMessageIdRef.current = null;
  };

  const handleSubmit = async () => {
    const prompt = input.trim();

    if (!prompt || running) {
      return;
    }

    if (!activeStatus?.configured) {
      setAppError(activeStatus?.message ?? "当前模式未配置完成。");
      setRuntimeNotice("无法发送请求");
      return;
    }

    const userMessage = createUiMessage("user", "你", prompt);
    const nextConversation = [
      ...conversationRef.current,
      {
        role: "user",
        content: prompt,
      } satisfies ConversationMessage,
    ];

    setMessages((current) => [...current, userMessage]);
    conversationRef.current = nextConversation;
    setInput("");
    setAppError(null);
    setRunning(true);
    setRuntimeNotice("正在启动后端代理...");

    const streamId = createClientId("stream");
    activeStreamIdRef.current = streamId;
    currentAssistantMessageIdRef.current = null;

    try {
      const result = await invoke<RunAgentTurnResult>("run_agent_turn", {
        request: {
          mode,
          streamId,
          messages: nextConversation,
        } satisfies RunAgentTurnRequest,
      });

      conversationRef.current = [
        ...conversationRef.current,
        ...result.newMessages.map((message) => ({
          role: message.role,
          content: message.content,
          ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
          ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
        })),
      ];

      setRuntimeNotice("本轮对话已完成");
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
                overflowY: "auto",
                padding: 20,
                display: "flex",
                flexDirection: "column",
              }}
            >
              <Space
                direction="vertical"
                size={4}
                style={{ display: "flex", marginBottom: 24 }}
              >
                <Text style={{ color: "#94a3b8", fontSize: 12, letterSpacing: 1.8 }}>
                  AI UNIVERSAL ASSISTANT
                </Text>
                <Title
                  level={3}
                  style={{
                    margin: 0,
                    color: "#f8fafc",
                    fontWeight: 600,
                    letterSpacing: -0.6,
                  }}
                >
                  Gemini-style Workspace
                </Title>
                <Paragraph
                  style={{
                    margin: 0,
                    color: "#94a3b8",
                    lineHeight: 1.7,
                  }}
                >
                  参考侧栏 + 主会话区模式，输入框固定在底部，历史消息只在聊天区内滚动。
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

                <div
                  style={{
                    marginTop: 16,
                    padding: "12px 14px",
                    borderRadius: 18,
                    border: "1px solid rgba(255,255,255,0.06)",
                    background: "rgba(255,255,255,0.03)",
                  }}
                >
                  <Text style={{ color: "#e2e8f0", fontSize: 14, fontWeight: 600 }}>
                    {MODE_LABELS[mode]}
                  </Text>
                  <Paragraph
                    style={{
                      margin: "8px 0 0",
                      color: "#94a3b8",
                      fontSize: 13,
                      lineHeight: 1.7,
                    }}
                  >
                    {MODE_DESCRIPTIONS[mode]}
                  </Paragraph>
                </div>
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
                <Space
                  direction="vertical"
                  size={10}
                  style={{ display: "flex" }}
                >
                  <Button
                    block
                    icon={<MessageOutlined />}
                    style={buttonGhostStyle}
                    onClick={resetConversation}
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

              <div
                style={{
                  marginTop: "auto",
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
                    对话与执行流
                  </Title>
                  <Paragraph
                    style={{
                      margin: "6px 0 0",
                      color: "#94a3b8",
                      lineHeight: 1.7,
                    }}
                  >
                    模型请求、Tool Calling、终端执行回传都由后端完成，前端只负责显示与交互。
                  </Paragraph>
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
                    {runtimeNotice}
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
                        <div
                          key={message.id}
                          className={`flex ${tone.wrapper}`}
                        >
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
                            <pre
                              style={{
                                margin: 0,
                                whiteSpace: "pre-wrap",
                                wordBreak: "break-word",
                                color: "#f8fafc",
                                fontSize: 14,
                                lineHeight: 1.9,
                                fontFamily:
                                  message.kind === "tool-call" ||
                                  message.kind === "tool-result"
                                    ? '"Cascadia Code","Consolas","SFMono-Regular",monospace'
                                    : '"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',
                              }}
                            >
                              {message.content}
                            </pre>
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
                  style={{
                    borderRadius: 30,
                    border: "1px solid rgba(255,255,255,0.08)",
                    background: "rgba(255,255,255,0.04)",
                    boxShadow: "0 18px 60px rgba(0, 0, 0, 0.28)",
                    padding: 18,
                  }}
                >
                  <TextArea
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
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
          </Content>
        </Layout>
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
