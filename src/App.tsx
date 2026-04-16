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
type MainPanel = "chat" | "skills" | "dingtalk" | "settings";
type LicensePhase = "checking" | "missing" | "valid" | "error";
type AuthPhase = "checking" | "anonymous" | "authenticated" | "error";
type AuthMode = "login" | "register";

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
              {attachment.kind === "image" ? "图片" : "音频"}
            </Tag>
          </div>
        </div>
      ))}
    </div>
  );
}

function renderActivationScreen(
  phase: LicensePhase,
  status: LicenseStatus | null,
  licenseBusy: boolean,
  licenseError: string | null,
  onImportClick: () => void,
  onRefresh: () => void,
  onClear: () => void,
) {
  const isChecking = phase === "checking";
  const title = status?.valid
    ? "许可证已验证"
    : isChecking
      ? "正在检查本地许可证"
      : "需要许可证";
  const subtitle = status?.valid
    ? "当前账号的桌面应用许可证已生效。"
    : "进入登录工作区前，请先导入签名许可证文件。";

  return (
    <div
      style={{
        minHeight: "100vh",
        background:
          "radial-gradient(circle at top, rgba(59,130,246,0.22), transparent 42%), linear-gradient(160deg, #020617 0%, #0f172a 55%, #111827 100%)",
        color: "#f8fafc",
        display: "grid",
        placeItems: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 760,
          borderRadius: 28,
          border: "1px solid rgba(255,255,255,0.08)",
          background: "rgba(15,23,42,0.86)",
          boxShadow: "0 32px 90px rgba(2, 6, 23, 0.52)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "28px 30px 22px",
            borderBottom: "1px solid rgba(255,255,255,0.08)",
            background:
              "linear-gradient(180deg, rgba(59,130,246,0.18) 0%, rgba(15,23,42,0) 100%)",
          }}
        >
          <Space size={14} align="start">
            <div
              style={{
                width: 52,
                height: 52,
                borderRadius: 18,
                background: "rgba(59,130,246,0.16)",
                display: "grid",
                placeItems: "center",
                flexShrink: 0,
              }}
            >
              <DesktopOutlined style={{ color: "#93c5fd", fontSize: 22 }} />
            </div>
            <div>
              <Title level={2} style={{ margin: 0, color: "#f8fafc" }}>
                {title}
              </Title>
              <Paragraph
                style={{
                  margin: "8px 0 0",
                  color: "#94a3b8",
                  fontSize: 14,
                  lineHeight: 1.8,
                }}
              >
                {subtitle}
              </Paragraph>
            </div>
          </Space>
        </div>

        <div style={{ padding: "28px 30px 30px" }}>
          {licenseError ? (
            <Alert
              type="error"
              showIcon
              message="许可证错误"
              description={licenseError}
              style={{ marginBottom: 18 }}
            />
          ) : null}

          {status ? (
            <Alert
              type={status.valid ? "success" : phase === "error" ? "error" : "info"}
              showIcon
              message={status.message}
              style={{ marginBottom: 18 }}
            />
          ) : null}

          <div
            style={{
              borderRadius: 22,
              border: "1px solid rgba(255,255,255,0.08)",
              background: "rgba(2,6,23,0.5)",
              padding: 22,
              marginBottom: 18,
            }}
          >
            <Space direction="vertical" size={12} style={{ display: "flex" }}>
              <div>
                <Text style={{ color: "#94a3b8", fontSize: 12 }}>授权账号</Text>
                <Paragraph style={{ margin: "8px 0 0", color: "#dbeafe", fontSize: 13 }}>
                  {status?.accountEmail ?? "待生成..."}
                </Paragraph>
              </div>

              <div>
                <Text style={{ color: "#94a3b8", fontSize: 12 }}>许可证存储位置</Text>
                <Paragraph style={{ margin: "8px 0 0", color: "#cbd5e1", fontSize: 13 }}>
                  {status?.appDataDir ?? "待生成..."}
                </Paragraph>
              </div>

              {status?.licenseId ? (
                <div>
                  <Text style={{ color: "#94a3b8", fontSize: 12 }}>许可证 ID</Text>
                  <Paragraph style={{ margin: "8px 0 0", color: "#f8fafc", fontSize: 13 }}>
                    {status.licenseId}
                  </Paragraph>
                </div>
              ) : null}
            </Space>
          </div>

          <Space wrap size={12}>
            <Button
              type="primary"
              size="large"
              icon={licenseBusy || isChecking ? <LoadingOutlined /> : <FileTextOutlined />}
              onClick={onImportClick}
              disabled={licenseBusy || isChecking}
            >
              导入许可证文件
            </Button>
            <Button size="large" onClick={onRefresh} disabled={licenseBusy}>
              刷新状态
            </Button>
            <Button danger size="large" onClick={onClear} disabled={licenseBusy}>
              清除许可证
            </Button>
          </Space>
        </div>
      </div>
    </div>
  );
}

function renderAuthScreen(
  mode: AuthMode,
  email: string,
  password: string,
  busy: boolean,
  sessionStatus: SessionStatus | null,
  authError: string | null,
  onModeChange: (mode: AuthMode) => void,
  onEmailChange: (value: string) => void,
  onPasswordChange: (value: string) => void,
  onSubmit: () => void,
) {
  const title = mode === "login" ? "登录" : "创建本地账号";
  const subtitle =
    mode === "login"
      ? "请使用与你的桌面许可证一致的邮箱地址登录。"
      : "先在当前设备创建本地账号，再使用已授权邮箱登录。";

  return (
    <div
      style={{
        minHeight: "100vh",
        background:
          "radial-gradient(circle at 18% 18%, rgba(51,167,255,0.18), transparent 24%), radial-gradient(circle at 82% 16%, rgba(246,197,102,0.14), transparent 20%), linear-gradient(135deg, #111111 0%, #171717 46%, #101828 100%)",
        color: "#f8fafc",
        display: "grid",
        placeItems: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 1180,
          minHeight: 720,
          borderRadius: 32,
          border: "1px solid rgba(255,255,255,0.08)",
          background: "rgba(18,18,18,0.96)",
          boxShadow: "0 40px 120px rgba(0,0,0,0.45)",
          overflow: "hidden",
          display: "flex",
          flexWrap: "wrap",
        }}
      >
        <div
          style={{
            position: "relative",
            flex: "1 1 620px",
            minWidth: 320,
            padding: "44px 44px 40px",
            background:
              "radial-gradient(circle at 20% 20%, rgba(51,167,255,0.16), transparent 28%), linear-gradient(180deg, rgba(255,255,255,0.02) 0%, rgba(255,255,255,0) 100%)",
            borderRight: "1px solid rgba(255,255,255,0.07)",
          }}
        >
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 14px",
              borderRadius: 999,
              border: "1px solid rgba(255,255,255,0.08)",
              background: "rgba(255,255,255,0.03)",
              color: "#d4d4d8",
              fontSize: 13,
            }}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 999,
                background: "#33a7ff",
                boxShadow: "0 0 16px rgba(51,167,255,0.8)",
              }}
            />
            HZCUclaw 桌面端
          </div>

          <div style={{ maxWidth: 520, marginTop: 92 }}>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 14px",
                borderRadius: 999,
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.08)",
                color: "#f6c566",
                fontSize: 12,
                letterSpacing: 0.4,
                textTransform: "uppercase",
              }}
            >
              已授权工作区
            </div>

            <Title
              level={1}
              style={{
                margin: "22px 0 16px",
                color: "#fafafa",
                fontSize: 64,
                lineHeight: 1.02,
                letterSpacing: -2.4,
                fontWeight: 600,
              }}
            >
              桌面端 AI，
              <br />
              由许可证
              <br />
              与账号共同保护。
            </Title>

            <Paragraph
              style={{
                margin: 0,
                color: "#9f9fa9",
                fontSize: 16,
                lineHeight: 1.9,
                maxWidth: 460,
              }}
            >
              这个页面将桌面端入口流程做了清晰分层：先验证本地许可证，再使用匹配账号登录。
            </Paragraph>

            <div
              style={{
                marginTop: 42,
                display: "grid",
                gap: 16,
              }}
            >
              {[
                "本地会话会持续保留，直到你手动退出登录",
                "许可证邮箱与登录邮箱必须保持一致",
                "在线与本地模型模式共用同一套授权入口",
              ].map((item) => (
                <div
                  key={item}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    padding: "14px 16px",
                    borderRadius: 18,
                    background: "rgba(255,255,255,0.03)",
                    border: "1px solid rgba(255,255,255,0.06)",
                    color: "#e5e7eb",
                  }}
                >
                  <span
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: 999,
                      background: "linear-gradient(135deg, #33a7ff 0%, #4cbe9c 100%)",
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ fontSize: 14 }}>{item}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div
          style={{
            position: "relative",
            flex: "1 1 420px",
            minWidth: 320,
            display: "grid",
            placeItems: "center",
            padding: "44px 34px",
            background:
              "radial-gradient(circle at 80% 0%, rgba(255,255,255,0.05), transparent 28%), #111111",
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: 420,
              borderRadius: 28,
              border: "1px solid rgba(255,255,255,0.08)",
              background: "rgba(255,255,255,0.03)",
              padding: 28,
              backdropFilter: "blur(10px)",
            }}
          >
            <Text
              style={{
                display: "block",
                color: "#f5f5f5",
                fontSize: 28,
                fontWeight: 600,
                letterSpacing: -0.6,
              }}
            >
              {title}
            </Text>
            <Paragraph
              style={{
                margin: "10px 0 0",
                color: "#8f8f9a",
                lineHeight: 1.8,
                fontSize: 14,
              }}
            >
              {subtitle}
            </Paragraph>

            <Segmented
              block
              size="large"
              value={mode}
              onChange={(value) => onModeChange(value as AuthMode)}
              options={[
                { label: "登录", value: "login" },
                { label: "注册", value: "register" },
              ]}
              style={{
                marginTop: 24,
                marginBottom: 20,
                background: "rgba(255,255,255,0.04)",
              }}
            />

            {authError ? (
              <Alert
                type="error"
                showIcon
                message="认证错误"
                description={authError}
                style={{ marginBottom: 18 }}
              />
            ) : null}

            {sessionStatus ? (
              <Alert
                type={sessionStatus.authenticated ? "success" : "info"}
                showIcon
                message={sessionStatus.message}
                style={{ marginBottom: 18 }}
              />
            ) : null}

            <Space direction="vertical" size={14} style={{ display: "flex" }}>
              <div>
                <Text
                  style={{
                    display: "block",
                    marginBottom: 8,
                    color: "#c9c9cf",
                    fontSize: 13,
                  }}
                >
                  邮箱
                </Text>
                <Input
                  size="large"
                  placeholder="请输入邮箱，例如 demo@example.com"
                  value={email}
                  disabled={busy}
                  onChange={(event) => onEmailChange(event.target.value)}
                  style={{
                    height: 48,
                    borderRadius: 16,
                    border: "1px solid rgba(255,255,255,0.08)",
                    background: "#1d1d1d",
                    color: "#f8fafc",
                  }}
                />
              </div>

              <div>
                <Text
                  style={{
                    display: "block",
                    marginBottom: 8,
                    color: "#c9c9cf",
                    fontSize: 13,
                  }}
                >
                  密码
                </Text>
                <Input.Password
                  size="large"
                  placeholder="至少 6 位"
                  value={password}
                  disabled={busy}
                  onChange={(event) => onPasswordChange(event.target.value)}
                  onPressEnter={() => void onSubmit()}
                  style={{
                    height: 48,
                    borderRadius: 16,
                    border: "1px solid rgba(255,255,255,0.08)",
                    background: "#1d1d1d",
                    color: "#f8fafc",
                  }}
                />
              </div>

              <Button
                type="primary"
                size="large"
                icon={busy ? <LoadingOutlined /> : undefined}
                onClick={onSubmit}
                disabled={!email.trim() || !password.trim() || busy}
                style={{
                  height: 52,
                  marginTop: 6,
                  borderRadius: 16,
                  border: "none",
                  background: "linear-gradient(135deg, #33a7ff 0%, #1677ff 100%)",
                  fontSize: 15,
                  fontWeight: 600,
                  boxShadow: "0 20px 50px rgba(23,119,255,0.25)",
                }}
              >
                {mode === "login" ? "登录并进入桌面" : "创建设备账号"}
              </Button>
            </Space>

            <div
              style={{
                marginTop: 22,
                paddingTop: 18,
                borderTop: "1px solid rgba(255,255,255,0.08)",
                color: "#777783",
                fontSize: 12,
                lineHeight: 1.8,
              }}
            >
              本地账号只保存在当前设备。退出登录会清除会话，但不会删除已导入的许可证。
            </div>
          </div>
        </div>
      </div>
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

    void loadSystemPromptSettings();
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
        {renderActivationScreen(
          licensePhase,
          licenseStatus,
          licenseBusy,
          licenseError,
          openLicensePicker,
          () => void refreshLicenseStatus(),
          () => void clearLocalLicense(),
        )}
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
        {renderAuthScreen(
          authMode,
          authEmail,
          authPassword,
          authBusy,
          sessionStatus,
          authError,
          setAuthMode,
          setAuthEmail,
          setAuthPassword,
          () => void handleAuthSubmit(),
        )}
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
      setActivePanel("dingtalk");
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
                    marginBottom: 18,
                    borderRadius: 20,
                    border: "1px solid rgba(255,255,255,0.08)",
                    background: "rgba(5,10,18,0.6)",
                    padding: 16,
                  }}
                >
                  <Text
                    style={{
                      display: "block",
                      color: "#94a3b8",
                      fontSize: 12,
                      marginBottom: 6,
                    }}
                  >
                    当前账号
                  </Text>
                  <Text style={{ display: "block", color: "#f8fafc", fontSize: 14 }}>
                    {currentUser?.email ?? sessionStatus?.email ?? "未知"}
                  </Text>
                  <Button
                    type="text"
                    onClick={() => void handleLogout()}
                    style={{ marginTop: 10, paddingInline: 0, color: "#93c5fd" }}
                  >
                    退出登录
                  </Button>
                </div>

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
                  <Button
                    block
                    icon={<ApiOutlined />}
                    style={navButtonStyle(activePanel === "dingtalk")}
                    onClick={() => setActivePanel("dingtalk")}
                  >
                    钉钉中继
                  </Button>
                  <Button
                    block
                    icon={<SettingOutlined />}
                    style={navButtonStyle(activePanel === "settings")}
                    onClick={() => setActivePanel("settings")}
                  >
                    提示词设置
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
                    ? "加载中"
                    : activeStatus?.configured
                      ? "就绪"
                      : "错误"}
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
                                      ? "输出中"
                                      : message.status === "error"
                                        ? "失败"
                                        : "完成"}
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
                        placeholder="请向 HZCUclaw 提问，例如：帮我检查当前目录结构并给出总结。"
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
                            style={{ color: "#cbd5e1" }}
                          >
                            添加附件
                          </Button>
                          <Text style={{ color: "#94a3b8", fontSize: 13 }}>
                            按 Ctrl/Cmd + Enter 发送
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
            ) : activePanel === "dingtalk" ? (
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
                      }}
                    >
                      <div>
                        <Text
                          style={{
                            display: "block",
                            color: "#f8fafc",
                            fontSize: 18,
                            fontWeight: 600,
                          }}
                        >
                          钉钉 Stream 模式
                        </Text>
                        <Paragraph
                          style={{
                            margin: "10px 0 0",
                            color: "#94a3b8",
                            fontSize: 13,
                            lineHeight: 1.8,
                            maxWidth: 620,
                          }}
                        >
                          你可以在这里启动或停止本地钉钉中继。要实现远程对话和远程控制，桌面应用必须持续在线。
                        </Paragraph>
                      </div>
                      <Space wrap size={12}>
                        <Button
                          type="primary"
                          icon={dingtalkBusy ? <LoadingOutlined /> : <ApiOutlined />}
                          onClick={() => void startDingtalkBot()}
                          disabled={dingtalkBusy || dingtalkStatus?.running}
                        >
                          启动中继
                        </Button>
                        <Button
                          danger
                          onClick={() => void stopDingtalkBot()}
                          disabled={dingtalkBusy || !dingtalkStatus?.running}
                        >
                          停止中继
                        </Button>
                        <Button
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
                      style={{ marginBottom: 18 }}
                    />
                  ) : null}

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                      gap: 14,
                      marginBottom: 18,
                    }}
                  >
                    {[
                      {
                        label: "中继状态",
                        value: dingtalkStatus?.running ? "运行中" : "已停止",
                        color: dingtalkStatus?.running ? "#22c55e" : "#f87171",
                      },
                      {
                        label: "代理模式",
                        value: dingtalkStatus?.mode
                          ? MODE_LABELS[dingtalkStatus.mode]
                          : MODE_LABELS.online,
                        color: "#93c5fd",
                      },
                      {
                        label: "远程 /run",
                        value: dingtalkStatus?.remoteCommandsEnabled
                          ? "已开启"
                          : "已关闭",
                        color: dingtalkStatus?.remoteCommandsEnabled
                          ? "#fbbf24"
                          : "#94a3b8",
                      },
                      {
                        label: "允许列表",
                        value: `${dingtalkStatus?.allowedSenderCount ?? 0} 个发送者 / ${
                          dingtalkStatus?.allowedChatCount ?? 0
                        } 个会话`,
                        color: "#cbd5e1",
                      },
                    ].map((item) => (
                      <div
                        key={item.label}
                        style={{
                          borderRadius: 20,
                          border: "1px solid rgba(255,255,255,0.08)",
                          background: "rgba(255,255,255,0.03)",
                          padding: "18px 20px",
                        }}
                      >
                        <Text
                          style={{
                            display: "block",
                            color: "#94a3b8",
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
                      border: "1px solid rgba(255,255,255,0.08)",
                      background: "rgba(255,255,255,0.03)",
                      padding: 20,
                      marginBottom: 18,
                    }}
                  >
                    <Text
                      style={{
                        display: "block",
                        color: "#f8fafc",
                        fontSize: 16,
                        fontWeight: 600,
                        marginBottom: 12,
                      }}
                    >
                      消息命令
                    </Text>
                    <Paragraph
                      style={{
                        margin: 0,
                        color: "#94a3b8",
                        fontSize: 13,
                        lineHeight: 1.9,
                      }}
                    >
                      发送普通文本即可开始远程对话。你也可以在钉钉里使用 `/status`、`/mode online`、`/mode local`、`/clear` 和
                      {" "}
                      <code>/run &lt;command&gt;</code>
                      {" "}
                      。其中 `/run` 只有在后端环境变量显式开启且命令前缀已加入白名单时才会生效。
                    </Paragraph>
                  </div>

                  <div
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
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 12,
                        marginBottom: 14,
                      }}
                    >
                      <Text
                        style={{
                          color: "#f8fafc",
                          fontSize: 16,
                          fontWeight: 600,
                        }}
                      >
                        中继事件
                      </Text>
                      <Text style={{ color: "#94a3b8", fontSize: 12 }}>
                        {dingtalkStatus?.events.length ?? 0} 条事件
                      </Text>
                    </div>

                    {!dingtalkStatus?.events.length ? (
                      <Text style={{ color: "#94a3b8", fontSize: 13 }}>
                        暂无钉钉中继事件。
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
                                borderRadius: 18,
                                border: "1px solid rgba(255,255,255,0.08)",
                                background: "rgba(2,6,23,0.5)",
                                padding: "12px 14px",
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
                                  style={{ marginInlineEnd: 0 }}
                                >
                                  {event.level === "error"
                                    ? "错误"
                                    : event.level === "warn"
                                      ? "警告"
                                      : "信息"}
                                </Tag>
                                <Text style={{ color: "#64748b", fontSize: 12 }}>
                                  {event.timestamp}
                                </Text>
                              </div>
                              <pre
                                style={{
                                  margin: 0,
                                  whiteSpace: "pre-wrap",
                                  wordBreak: "break-word",
                                  color: "#dbeafe",
                                  fontSize: 13,
                                  lineHeight: 1.8,
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
            ) : activePanel === "settings" ? (
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
                      }}
                    >
                      <div>
                        <Text
                          style={{
                            display: "block",
                            color: "#f8fafc",
                            fontSize: 18,
                            fontWeight: 600,
                          }}
                        >
                          系统提示词设置
                        </Text>
                        <Paragraph
                          style={{
                            margin: "10px 0 0",
                            color: "#94a3b8",
                            fontSize: 13,
                            lineHeight: 1.8,
                            maxWidth: 680,
                          }}
                        >
                          在这里编辑会追加到运行时环境提示词前面的自定义系统提示词。它会同时影响桌面端对话和钉钉远程对话。
                        </Paragraph>
                      </div>
                      <Space wrap size={12}>
                        <Button
                          onClick={() => void refreshSystemPromptSettings()}
                          disabled={loadingSystemPrompt || savingSystemPrompt}
                        >
                          重新加载
                        </Button>
                        <Button
                          onClick={() => void resetSystemPromptSettings()}
                          disabled={
                            loadingSystemPrompt ||
                            savingSystemPrompt ||
                            !systemPromptDraft.trim()
                          }
                        >
                          重置
                        </Button>
                        <Button
                          type="primary"
                          icon={savingSystemPrompt ? <LoadingOutlined /> : <SettingOutlined />}
                          onClick={() => void saveSystemPromptSettings()}
                          disabled={loadingSystemPrompt || savingSystemPrompt || !systemPromptDirty}
                        >
                          保存
                        </Button>
                      </Space>
                    </Space>
                  </div>

                  <div
                    style={{
                      borderRadius: 24,
                      border: "1px solid rgba(255,255,255,0.08)",
                      background: "rgba(255,255,255,0.03)",
                      padding: 20,
                      marginBottom: 18,
                    }}
                  >
                    <Text
                      style={{
                        display: "block",
                        color: "#f8fafc",
                        fontSize: 16,
                        fontWeight: 600,
                        marginBottom: 12,
                      }}
                    >
                      自定义系统提示词
                    </Text>
                    <Paragraph
                      style={{
                        margin: "0 0 14px",
                        color: "#94a3b8",
                        fontSize: 13,
                        lineHeight: 1.8,
                      }}
                    >
                      留空时仅使用内置系统提示词和提示词技能。若在这里保存自定义内容，它会在每次模型请求前追加到基础系统提示词之后。
                    </Paragraph>
                    <TextArea
                      value={systemPromptDraft}
                      onChange={(event) => setSystemPromptDraft(event.target.value)}
                      autoSize={{ minRows: 12, maxRows: 24 }}
                      placeholder="请在这里编写你的自定义系统提示词..."
                      disabled={loadingSystemPrompt || savingSystemPrompt}
                      style={{
                        color: "#f8fafc",
                        background: "rgba(2,6,23,0.72)",
                        borderRadius: 18,
                        border: "1px solid rgba(255,255,255,0.08)",
                        padding: 16,
                        fontSize: 13,
                        lineHeight: 1.8,
                        fontFamily:
                          '"Cascadia Code","Consolas","SFMono-Regular",monospace',
                      }}
                    />
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 12,
                        marginTop: 12,
                      }}
                    >
                      <Text style={{ color: "#94a3b8", fontSize: 12 }}>
                        {loadingSystemPrompt
                          ? "正在加载当前设置..."
                          : `${systemPromptDraft.length} 个字符`}
                      </Text>
                      <Text
                        style={{
                          color: systemPromptDirty ? "#fbbf24" : "#64748b",
                          fontSize: 12,
                        }}
                      >
                        {systemPromptDirty ? "有未保存的更改" : "已保存"}
                      </Text>
                    </div>
                  </div>

                  <Alert
                    type="info"
                    showIcon
                    message="工作方式"
                    description="内置基础提示词仍然会生效。这里的自定义提示词只是额外追加的一层，会在运行时环境信息和已加载技能之前注入。"
                    style={{
                      borderRadius: 18,
                      background: "rgba(15,23,42,0.72)",
                      border: "1px solid rgba(148,163,184,0.2)",
                    }}
                  />
                </div>
              </div>
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
                        当前未检测到任何技能。
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
                                      {skill.skillType === "tool" ? "工具" : "提示词"}
                                    </Tag>
                                    <Tag color={skill.enabled ? "green" : "red"}>
                                      {skill.enabled ? "已启用" : "已停用"}
                                    </Tag>
                                    {skill.requiresConfirmation ? (
                                      <Tag color="gold">需要确认</Tag>
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
                                {skill.id === "execute-terminal-command" ? (
                                  <div
                                    style={{
                                      marginTop: 14,
                                      padding: "14px 16px",
                                      borderRadius: 18,
                                      border: "1px solid rgba(255,255,255,0.08)",
                                      background: "rgba(15,23,42,0.52)",
                                    }}
                                  >
                                    <div
                                      style={{
                                        display: "flex",
                                        alignItems: "center",
                                        justifyContent: "space-between",
                                        gap: 16,
                                      }}
                                    >
                                      <div style={{ minWidth: 0 }}>
                                        <Text
                                          style={{
                                            display: "block",
                                            color: "#f8fafc",
                                            fontSize: 13,
                                            fontWeight: 600,
                                          }}
                                        >
                                          是否不经过审核直接运行终端命令？
                                        </Text>
                                        <Text
                                          style={{
                                            display: "block",
                                            color: "#94a3b8",
                                            fontSize: 12,
                                            marginTop: 6,
                                            lineHeight: 1.7,
                                          }}
                                        >
                                          开启后，桌面聊天和钉钉远程对话中的终端命令都会直接执行；关闭后，桌面端仍需点击确认，钉钉端会直接拒绝执行。
                                        </Text>
                                      </div>
                                      <Switch
                                        checked={!skill.requiresConfirmation}
                                        loading={updating}
                                        checkedChildren="开启"
                                        unCheckedChildren="关闭"
                                        onChange={(checked) =>
                                          void handleTerminalDirectExecutionToggle(checked)
                                        }
                                      />
                                    </div>
                                  </div>
                                ) : null}
                              </div>

                              <div style={{ flexShrink: 0 }}>
                                <Switch
                                  checked={skill.enabled}
                                  loading={updating}
                                  checkedChildren="开启"
                                  unCheckedChildren="关闭"
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
