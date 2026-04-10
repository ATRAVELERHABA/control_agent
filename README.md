# AI-Universal-Assistant

A desktop graduation project built with Tauri v2, React, Tailwind CSS, and Rust.

## Scripts

- `npm install`: install frontend dependencies
- `npm run dev`: start the Vite dev server
- `npm run tauri dev`: start the desktop app in development mode
- `npm run build`: build the frontend

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
- Install the dependency with `control_agent/.venv/Scripts/python -m pip install -r control_agent/requirements.txt`
- The backend now prefers `control_agent/.venv/Scripts/python.exe` when it exists
- The script prefers the renamed `ddgs` package and also supports the legacy `duckduckgo_search` import path
