import { Tag, Typography } from "antd";
import type { MessageAttachment } from "../types/ui";

const { Text } = Typography;

import { formatAttachmentSize } from "../lib/utils";

interface MessageAttachmentsProps {
  attachments?: MessageAttachment[];
  light?: boolean;
}

export function MessageAttachments({ attachments, light = false }: MessageAttachmentsProps) {
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
            border: light ? "1px solid #e5e7eb" : "1px solid rgba(255,255,255,0.08)",
            background: light ? "#f8fafc" : "rgba(2,6,23,0.48)",
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
                  color: light ? "#111827" : "#f8fafc",
                  fontSize: 13,
                  fontWeight: 500,
                }}
                ellipsis
              >
                {attachment.displayName}
              </Text>
              <Text style={{ color: light ? "#6b7280" : "#94a3b8", fontSize: 12 }}>
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
