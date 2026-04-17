import { LoadingOutlined } from "@ant-design/icons";
import { Alert, Button, Input, Segmented, Space, Typography } from "antd";
import type { SessionStatus } from "../lib/llm";
import type { AuthMode } from "../types/ui";

const { Title, Paragraph, Text } = Typography;

interface AuthScreenProps {
  mode: AuthMode;
  email: string;
  password: string;
  busy: boolean;
  sessionStatus: SessionStatus | null;
  authError: string | null;
  onModeChange: (mode: AuthMode) => void;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: () => void;
}

export function AuthScreen({
  mode,
  email,
  password,
  busy,
  sessionStatus,
  authError,
  onModeChange,
  onEmailChange,
  onPasswordChange,
  onSubmit,
}: AuthScreenProps) {
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
