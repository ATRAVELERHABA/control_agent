// src/components/ActivationScreen.tsx
import { DesktopOutlined, FileTextOutlined, LoadingOutlined } from "@ant-design/icons";
import { Alert, Button, Space, Typography } from "antd";
import type { LicenseStatus } from "../lib/llm";
import type { LicensePhase } from "../types/ui";

const { Title, Paragraph, Text } = Typography;

interface ActivationScreenProps {
  phase: LicensePhase;
  status: LicenseStatus | null;
  licenseBusy: boolean;
  licenseError: string | null;
  onImportClick: () => void;
  onRefresh: () => void;
  onClear: () => void;
}

export function ActivationScreen({
  phase,
  status,
  licenseBusy,
  licenseError,
  onImportClick,
  onRefresh,
  onClear,
}: ActivationScreenProps) {
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
