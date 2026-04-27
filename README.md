# AI-Universal-Assistant

A desktop graduation project built with Tauri v2, React, Tailwind CSS, and Rust.

## Scripts

- `npm install`: install frontend dependencies
- `npm run dev`: start the Vite dev server
- `npm run tauri dev`: start the desktop app in development mode
- `npm run build`: build the frontend
- `npm run tauri:build:installer`: build the current Windows NSIS installer
- `npm run tauri:build:linux`: build Linux bundles with the auto-loaded `src-tauri/tauri.linux.conf.json`
- `npm run tauri:build:linux:deb`: build only the Linux `.deb` bundle
- `npm run tauri:build:linux:appimage`: build only the Linux `.appimage` bundle

## First Feature

The initial prototype exposes a Tauri command named `run_command`. The frontend sends a command string through `invoke`, and the Rust backend executes it with the platform shell:

- Windows: `powershell -Command`
- Linux and macOS: `bash -c`

## Environment Variables

For long-term local configuration, store model settings in a root `.env` file.
These variables are now read by the Rust backend, not by the frontend.

1. Copy `.env.example` to `.env`
2. Fill in the values you want to use
3. Start the app with `npm run tauri dev`

Supported variables:

- `OPENAI_BASE_URL`
- `OPENAI_MODEL`
- `OPENAI_API_KEY`
- `OPENAI_VISION_MODEL`
- `OPENAI_AUDIO_MODEL`
- `ALIYUN_API_KEY`
- `ALIYUN_MODEL`
- `ALIYUN_VISION_MODEL`
- `ALIYUN_AUDIO_MODEL`
- `OLLAMA_BASE_URL`
- `OLLAMA_MODEL`
- `OLLAMA_API_KEY`
- `OLLAMA_VISION_MODEL`
- `LOCAL_AUDIO_MODEL`

Online mode fallback:

- If `OPENAI_BASE_URL` or `OPENAI_MODEL` is missing, the backend automatically falls back to Alibaba Cloud DashScope
- Fallback URL: `https://dashscope.aliyuncs.com/compatible-mode/v1`
- Fallback model: `qwen3-max`
- Fallback key: `ALIYUN_API_KEY` preferred, `OPENAI_API_KEY` accepted as a fallback

Alibaba Cloud multimodal fallback:

- Generic chat fallback model: `ALIYUN_MODEL` or default `qwen3-max`
- Vision fallback model: `ALIYUN_VISION_MODEL` or default `qwen3.6-plus`
- Audio fallback model: `ALIYUN_AUDIO_MODEL` or default `qwen3-asr-flash`

Notes:

- `.env` is ignored by git and should contain your real secrets
- `.env.example` is safe to commit and should only contain placeholders
- Frontend no longer accepts URL or API Key input
- The UI only switches between online mode and local mode; actual config must exist in backend environment variables

Multimodal notes:

- Image analysis uses `OPENAI_VISION_MODEL` in online mode when set, otherwise falls back to `OPENAI_MODEL`
- Image analysis uses `OLLAMA_VISION_MODEL` in local mode when set, otherwise falls back to `OLLAMA_MODEL`
- Audio transcription uses `OPENAI_AUDIO_MODEL` in online mode when set, otherwise falls back to `OPENAI_MODEL`
- Local audio transcription uses `LOCAL_AUDIO_MODEL` and the Python helper under `control_agent/scripts/audio_transcribe_tool.py`

## Skills Directory

The project supports a local `.skills` directory at the repo root.

- Each skill is stored as a separate `.json` file
- `type = "prompt"` skills are injected into the system prompt
- `type = "tool"` skills are exposed to the model as function-calling tools
- `execute_terminal_command` is now managed as a tool skill in `.skills/execute_terminal_command.json`
- `duckduckgo_search` is available as a tool skill in `.skills/duckduckgo_search.json`

See `.skills/README.md` for the full structure.

## DuckDuckGo Search Tool

The DuckDuckGo tool is implemented by `control_agent/scripts/duckduckgo_search_tool.py`.

- Create a project-local virtualenv with `python -m venv control_agent/.venv`
- Install the dependency with `control_agent/.venv/Scripts/python -m pip install -r control_agent/requirements.txt` on Windows
- Install the dependency with `control_agent/.venv/bin/python -m pip install -r control_agent/requirements.txt` on Linux
- The backend now prefers `control_agent/.venv/Scripts/python.exe` on Windows and `control_agent/.venv/bin/python` on Linux
- The script prefers the renamed `ddgs` package and also supports the legacy `duckduckgo_search` import path

## Offline License Activation

The app ships with an offline activation gate:

- On startup it checks the local license state first, then the local login session.
- If no valid license exists, it stays on a dedicated license screen.
- Importing a signed license file unlocks the login/register screen for the licensed account.

### Demo flow (end-to-end)

1. Start the desktop app:

- `npm run tauri dev`

2. Decide which account email should own the desktop license.

3. Issue a license file with the repo CLI:

- `cargo run --release --manifest-path license_tool/Cargo.toml -- issue --email "demo@example.com" --out "./demo-license.json"`

4. Back in the app, click **Import License File** and select `demo-license.json`.
5. Register or log in with the same email address.

6. Restart the app: it should keep the local session until you manually sign out.

### Reset / test cases

- Use **Clear License** on the license screen to remove local license state.
- If you edit any payload field in the license JSON, signature verification should fail and activation will be rejected.

## DingTalk Remote Relay

The project now includes an experimental DingTalk Stream Mode relay so the desktop agent can be reached from DingTalk group chats and direct chats.

### Install Python dependencies

- Create a local virtualenv: `python -m venv control_agent/.venv`
- Install helper dependencies on Windows: `control_agent/.venv/Scripts/python -m pip install -r control_agent/requirements.txt`
- Install helper dependencies on Linux: `control_agent/.venv/bin/python -m pip install -r control_agent/requirements.txt`

## Linux Packaging Notes

- Tauri v2 will automatically merge `src-tauri/tauri.linux.conf.json` when you run Linux builds.
- The Linux bundle flow copies `.skills`, `control_agent/scripts`, `.env.example`, and Linux `site-packages` into `src-tauri/bundled-resources`.
- If you want to ship a bundled Linux Python runtime, set `EMBEDDED_PYTHON_HOME` or `LINUX_EMBEDDED_PYTHON_HOME` before building.
- If no embedded Linux Python runtime is provided, the packaged app falls back to `python3` or `python` on the target system.

### Required `.env` values

- `DINGTALK_CLIENT_ID`
- `DINGTALK_CLIENT_SECRET`

### Optional `.env` values

- `DINGTALK_AGENT_MODE=online|local`
- `DINGTALK_ALLOWED_SENDERS=user1,user2`
- `DINGTALK_ALLOWED_CHATS=chat1,chat2`
- `DINGTALK_ENABLE_REMOTE_COMMANDS=true|false`
- `DINGTALK_ALLOWED_COMMAND_PREFIXES=dir,Get-ChildItem,pwd`

### Current remote commands

- `/help`
- `/status`
- `/mode online`
- `/mode local`
- `/clear`
- `/run <command>`

### Current limitations

- This first slice only supports text chat and text command replies.
- `/run` is intentionally disabled unless `DINGTALK_ENABLE_REMOTE_COMMANDS=true`.
- Even after enabling `/run`, commands are still gated by `DINGTALK_ALLOWED_COMMAND_PREFIXES`.
- Remote chat currently exposes only non-confirmation tools to the model. Terminal execution is not exposed through autonomous tool-calling in DingTalk.
