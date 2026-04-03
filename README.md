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
- `ALIYUN_API_KEY`
- `OLLAMA_BASE_URL`
- `OLLAMA_MODEL`
- `OLLAMA_API_KEY`

Online mode fallback:

- If `OPENAI_BASE_URL` is empty, the backend automatically falls back to Alibaba Cloud DashScope
- Fallback URL: `https://dashscope.aliyuncs.com/compatible-mode/v1`
- Fallback model: `qwen3-max`
- Fallback key: `ALIYUN_API_KEY` preferred, `OPENAI_API_KEY` accepted as a fallback

Notes:

- `.env` is ignored by git and should contain your real secrets
- `.env.example` is safe to commit and should only contain placeholders
- Frontend no longer accepts URL or API Key input
- The UI only switches between online mode and local mode; actual config must exist in backend environment variables
