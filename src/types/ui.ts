export type UiMessageKind = "user" | "assistant" | "tool-call" | "tool-result" | "error";
export type UiMessageStatus = "streaming" | "completed" | "error";
export type MainPanel = "chat" | "skills" | "dingtalk" | "settings";
export type LicensePhase = "checking" | "missing" | "valid" | "error";
export type AuthPhase = "checking" | "anonymous" | "authenticated" | "error";
export type AuthMode = "login" | "register";
export type AppearanceMode = "light" | "dark" | "system";

export interface UiMessage {
  id: string;
  kind: UiMessageKind;
  title: string;
  content: string;
  status: UiMessageStatus;
  attachments?: MessageAttachment[];
}

export interface PendingAttachment {
  id: string;
  file: File;
  kind: string; // AssetKind 
  previewUrl?: string;
}

export interface MessageAttachment {
  id: string;
  kind: string; // AssetKind
  displayName: string;
  mimeType: string;
  sizeBytes: number;
  previewUrl?: string;
  assetId?: string;
}
