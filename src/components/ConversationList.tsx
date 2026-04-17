import { DeleteOutlined, PlusOutlined, SearchOutlined } from "@ant-design/icons";
import { Button, Input, Space, Spin, Typography } from "antd";
import type { ConversationSummary } from "../lib/llm";

const { Text } = Typography;

interface ConversationListProps {
  conversations: ConversationSummary[];
  activeConversationId: string | null;
  loading: boolean;
  isLight: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string, event: React.MouseEvent) => void;
  onNew: () => void;
}

export function ConversationList({
  conversations,
  activeConversationId,
  loading,
  isLight,
  onSelect,
  onDelete,
  onNew,
}: ConversationListProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <Input
        prefix={<SearchOutlined style={{ color: "#94a3b8" }} />}
        placeholder="搜索记录"
        style={{
          borderRadius: 18,
          marginBottom: 12,
          background: isLight ? "#fff" : "rgba(255,255,255,0.06)",
          border: "none",
          color: isLight ? "#111827" : "#f8fafc",
        }}
      />
      <Button
        icon={<PlusOutlined />}
        onClick={onNew}
        style={{
          borderRadius: 16,
          height: 40,
          marginBottom: 20,
          background: isLight ? "#fff" : "rgba(255,255,255,0.06)",
          border: "none",
          color: isLight ? "#111827" : "#e2e8f0",
        }}
      >
        新建对话
      </Button>

      <div style={{ flex: 1, overflowY: "auto", paddingRight: 4 }}>
        {loading ? (
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <Spin size="small" />
          </div>
        ) : conversations.length === 0 ? (
          <Text style={{ color: isLight ? "#9ca3af" : "#64748b", fontSize: 12, display: "block", textAlign: "center" }}>
            还没有历史记录哦
          </Text>
        ) : (
          <Space direction="vertical" size={8} style={{ display: "flex" }}>
            {conversations.map((conv) => (
              <div
                key={conv.id}
                onClick={() => onSelect(conv.id)}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  width: "100%",
                  border:
                    activeConversationId === conv.id
                      ? isLight
                        ? "1px solid #3b82f6"
                        : "1px solid #3b82f6"
                      : isLight
                        ? "1px solid #e5e7eb"
                        : "1px solid rgba(255,255,255,0.06)",
                  background:
                    activeConversationId === conv.id
                      ? isLight
                        ? "#eff6ff"
                        : "rgba(59,130,246,0.1)"
                      : isLight
                        ? "#f8fafc"
                        : "rgba(255,255,255,0.02)",
                  borderRadius: 14,
                  padding: "10px 12px",
                  cursor: "pointer",
                  transition: "all 0.2s",
                }}
              >
                <div style={{ flex: 1, overflow: "hidden" }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 500,
                      marginBottom: 4,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      color: isLight ? "#111827" : "#f1f5f9",
                    }}
                  >
                    {conv.title || "新对话"}
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: isLight ? "#6b7280" : "#94a3b8",
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                      lineHeight: 1.5,
                      wordBreak: "break-all",
                    }}
                  >
                    {conv.lastPreview || "空空如也"}
                  </div>
                </div>
                <Button
                  type="text"
                  icon={<DeleteOutlined />}
                  size="small"
                  onClick={(e) => onDelete(conv.id, e)}
                  style={{
                    marginLeft: 8,
                    color: isLight ? "#9ca3af" : "#64748b",
                  }}
                />
              </div>
            ))}
          </Space>
        )}
      </div>
    </div>
  );
}