import argparse
import json
import os
import platform
import socket
import sys
import threading
import traceback
import uuid

import requests

import dingtalk_stream
from dingtalk_stream import AckMessage, CallbackMessage
from dingtalk_stream.chatbot import ChatbotHandler, ChatbotMessage
from dingtalk_stream.frames import Headers

EMIT_LOCK = threading.Lock()
DINGTALK_DIRECT_HOSTS = [
    "api.dingtalk.com",
    "wss-open-connection-union.dingtalk.com",
    ".dingtalk.com",
]


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8", errors="strict")


def emit(payload):
    with EMIT_LOCK:
        try:
            sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
            sys.stdout.flush()
        except Exception as error:  # noqa: BLE001
            sys.stderr.write(f"[relay][emit-error] {error!r}\n")
            sys.stderr.write(traceback.format_exc() + "\n")
            sys.stderr.flush()


def log(message, level="info"):
    emit({"type": "log", "level": level, "message": message})


def stderr(message):
    sys.stderr.write(message + "\n")
    sys.stderr.flush()


def configure_direct_networking():
    force_direct = os.environ.get("DINGTALK_FORCE_DIRECT", "true").strip().lower()
    if force_direct not in {"1", "true", "yes", "on"}:
        log("DingTalk 直连模式已被 DINGTALK_FORCE_DIRECT 关闭。", "warn")
        return

    existing_no_proxy = os.environ.get("NO_PROXY") or os.environ.get("no_proxy") or ""
    no_proxy_parts = [part.strip() for part in existing_no_proxy.split(",") if part.strip()]
    for host in DINGTALK_DIRECT_HOSTS:
        if host not in no_proxy_parts:
            no_proxy_parts.append(host)

    merged_no_proxy = ",".join(no_proxy_parts)
    os.environ["NO_PROXY"] = merged_no_proxy
    os.environ["no_proxy"] = merged_no_proxy

    cleared = []
    for key in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ]:
        if os.environ.pop(key, None):
            cleared.append(key)

    log(
        "已配置 DingTalk 进程内直连偏好。"
        f" 已清理代理环境变量={cleared if cleared else '(无)'},"
        f" NO_PROXY={merged_no_proxy}"
    )


def diagnose_host(host, port=443, timeout=5):
    try:
        addrinfos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        ips = []
        for item in addrinfos:
            ip = item[4][0]
            if ip not in ips:
                ips.append(ip)

        log(f"域名解析检查：{host}:{port} -> {ips}")

        if any(ip.startswith("198.18.") for ip in ips):
            log(
                f"警告：{host} 解析到了 198.18.x.x 网段，这通常表示命中了 Clash/TUN 虚拟网卡，而不是 DIRECT。",
                "warn",
            )

        with socket.create_connection((host, port), timeout=timeout):
            log(f"TCP 连通性检查成功：{host}:{port}")
    except Exception as error:  # noqa: BLE001
        log(f"网络自检失败：{host}:{port}，错误={error!r}", "error")


def startup_self_check():
    proxy_snapshot = {
        key: os.environ.get(key)
        for key in [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
            "NO_PROXY",
            "no_proxy",
        ]
        if os.environ.get(key)
    }

    log(
        f"启动自检：Python={platform.python_version()}，"
        f"平台={platform.platform()}，"
        f"代理环境变量={proxy_snapshot if proxy_snapshot else '(未检测到)'}"
    )
    diagnose_host("api.dingtalk.com", 443)
    diagnose_host("wss-open-connection-union.dingtalk.com", 443)


def first_non_empty(*values):
    for value in values:
        if value is None:
            continue
        if isinstance(value, str):
            if value.strip():
                return value
            continue
        return value
    return None


def extract_text(raw, incoming):
    text_block = raw.get("text") or {}
    if isinstance(text_block, dict):
        text_content = text_block.get("content")
        if isinstance(text_content, str) and text_content.strip():
            return text_content

    content = raw.get("content")
    if isinstance(content, str) and content.strip():
        return content

    incoming_text = getattr(incoming, "text", None)
    if isinstance(incoming_text, dict):
        text_content = incoming_text.get("content")
        if isinstance(text_content, str) and text_content.strip():
            return text_content

    if hasattr(incoming_text, "content"):
        text_content = getattr(incoming_text, "content")
        if isinstance(text_content, str) and text_content.strip():
            return text_content

    return ""


class RelayHandler(ChatbotHandler):
    def __init__(self):
        super().__init__()
        self._lock = threading.Lock()
        self._pending = {}

    async def raw_process(self, callback: CallbackMessage):
        request_id = None
        try:
            stderr(
                "[relay][raw_process] 开始处理"
                f" topic={getattr(callback.headers, 'topic', '(unknown)')}"
                f" message_id={getattr(callback.headers, 'message_id', '(unknown)')}"
            )

            raw = callback.data or {}
            log(
                f"收到回调：topic={getattr(callback.headers, 'topic', '(unknown)')}，"
                f"message_id={getattr(callback.headers, 'message_id', '(unknown)')}"
            )

            incoming = ChatbotMessage.from_dict(raw)
            request_id = str(
                first_non_empty(
                    raw.get("msgId"),
                    raw.get("messageId"),
                    getattr(incoming, "msg_id", None),
                    getattr(incoming, "message_id", None),
                    uuid.uuid4().hex,
                )
            )

            with self._lock:
                self._pending[request_id] = incoming

            conversation_type = str(first_non_empty(raw.get("conversationType"), ""))
            payload = {
                "type": "incoming_message",
                "requestId": request_id,
                "text": extract_text(raw, incoming),
                "senderId": str(
                    first_non_empty(
                        raw.get("senderId"),
                        getattr(incoming, "sender_id", None),
                        "",
                    )
                ),
                "senderStaffId": first_non_empty(
                    raw.get("senderStaffId"),
                    getattr(incoming, "sender_staff_id", None),
                ),
                "senderNick": first_non_empty(
                    raw.get("senderNick"),
                    getattr(incoming, "sender_nick", None),
                    getattr(incoming, "senderName", None),
                ),
                "conversationId": first_non_empty(
                    raw.get("conversationId"),
                    getattr(incoming, "conversation_id", None),
                ),
                "chatId": first_non_empty(
                    raw.get("chatId"),
                    getattr(incoming, "chat_id", None),
                ),
                "isGroup": conversation_type == "2",
            }
            emit(payload)
            log(
                f"已向桌面端转发 incoming_message，request_id={request_id}，"
                f"text_preview={str(payload.get('text', ''))[:120]!r}"
            )

            ack_message = AckMessage()
            ack_message.code = AckMessage.STATUS_OK
            ack_message.headers.message_id = callback.headers.message_id
            ack_message.headers.content_type = Headers.CONTENT_TYPE_APPLICATION_JSON
            ack_message.message = "ok"
            ack_message.data = {"response": "OK"}

            stderr(f"[relay][raw_process] 处理完成 request_id={request_id}")
            return ack_message
        except Exception as error:  # noqa: BLE001
            sys.stderr.write(f"[relay][process-error] {error!r}\n")
            sys.stderr.write(traceback.format_exc() + "\n")
            sys.stderr.flush()

            if request_id:
                with self._lock:
                    self._pending.pop(request_id, None)

            ack_message = AckMessage()
            ack_message.code = AckMessage.STATUS_OK
            ack_message.headers.message_id = callback.headers.message_id
            ack_message.headers.content_type = Headers.CONTENT_TYPE_APPLICATION_JSON
            ack_message.message = "error"
            ack_message.data = {"response": "worker error"}
            return ack_message

    def send_text_by_request_id(self, request_id, text, *, consume, mention_sender):
        with self._lock:
            if consume:
                incoming = self._pending.pop(request_id, None)
            else:
                incoming = self._pending.get(request_id)

        if incoming is None:
            raise KeyError(f"未找到待回复请求，request_id={request_id}")
        if not getattr(incoming, "session_webhook", None):
            raise ValueError("incoming message 缺少 session_webhook")

        values = {
            "msgtype": "text",
            "text": {
                "content": text,
            },
            "at": {
                "atUserIds": [incoming.sender_staff_id]
                if mention_sender and incoming.sender_staff_id
                else [],
            },
        }
        response = requests.post(
            incoming.session_webhook,
            headers={
                "Content-Type": "application/json; charset=utf-8",
                "Accept": "*/*",
            },
            json=values,
            timeout=15,
        )
        response.raise_for_status()
        log(
            f"回复已发送到钉钉，request_id={request_id}，"
            f"status={response.status_code}，body={response.text[:240]!r}"
        )
        return response.json() if response.text.strip() else None

    def notify_by_request_id(self, request_id, text):
        return self.send_text_by_request_id(
            request_id,
            text,
            consume=False,
            mention_sender=False,
        )

    def reply_by_request_id(self, request_id, text):
        return self.send_text_by_request_id(
            request_id,
            text,
            consume=True,
            mention_sender=True,
        )


def stdin_loop(handler: RelayHandler):
    for line in sys.stdin:
        payload_text = line.strip()
        if not payload_text:
            continue

        try:
            payload = json.loads(payload_text)
        except json.JSONDecodeError as error:
            emit({"type": "error", "message": f"stdin JSON 解析失败：{error}"})
            continue

        command_type = payload.get("type")

        if command_type in {"reply_text", "notify_text"}:
            request_id = str(payload.get("requestId") or "").strip()
            text = str(payload.get("text") or "").strip()

            if not request_id:
                emit({"type": "error", "message": f"{command_type} 缺少 requestId"})
                continue

            try:
                if command_type == "notify_text":
                    handler.notify_by_request_id(request_id, text or "(empty notice)")
                    message = f"已完成钉钉处理中提示发送，request_id={request_id}"
                else:
                    handler.reply_by_request_id(request_id, text or "(empty reply)")
                    message = f"已完成钉钉最终回复发送，request_id={request_id}"

                emit(
                    {
                        "type": "sent",
                        "level": "info",
                        "message": message,
                    }
                )
            except Exception as error:  # noqa: BLE001
                emit(
                    {
                        "type": "error",
                        "message": (
                            f"钉钉消息发送失败，type={command_type}，"
                            f"request_id={request_id}，error={error}"
                        ),
                    }
                )
        elif command_type == "shutdown":
            emit({"type": "log", "level": "info", "message": "收到关闭请求，worker 即将退出。"})
            break
        else:
            emit({"type": "error", "message": f"不支持的 stdin 命令：{command_type}"})


def main():
    parser = argparse.ArgumentParser(description="DingTalk Stream Mode relay worker")
    parser.add_argument("--client-id", required=True)
    parser.add_argument("--client-secret", required=True)
    args = parser.parse_args()

    handler = RelayHandler()
    stdin_thread = threading.Thread(target=stdin_loop, args=(handler,), daemon=True)
    stdin_thread.start()

    configure_direct_networking()
    startup_self_check()

    credential = dingtalk_stream.Credential(args.client_id, args.client_secret)
    client = dingtalk_stream.DingTalkStreamClient(credential)
    client.register_callback_handler(ChatbotMessage.TOPIC, handler)

    log("DingTalk Stream worker 已初始化。")
    log(f"已注册回调 topic：{ChatbotMessage.TOPIC}")
    stderr("DingTalk Stream worker 已初始化。")

    try:
        if hasattr(client, "start_forever"):
            client.start_forever()
        else:
            client.start()
    except Exception as error:  # noqa: BLE001
        emit({"type": "error", "message": f"DingTalk Stream worker 崩溃：{error}"})
        raise


if __name__ == "__main__":
    main()
