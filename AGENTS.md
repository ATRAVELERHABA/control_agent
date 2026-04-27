# Repository Guidelines

## Project Structure & Module Organization
`src/` contains the React + TypeScript UI, with shared pieces in `src/components/`, `src/lib/`, and `src/types/`. `src-tauri/` is the Rust backend and Tauri shell, split into focused modules like `llm.rs`, `search.rs`, `auth.rs`, and `history.rs`. `control_agent/` holds Python helpers for search, audio transcription, and DingTalk relay. `.skills/` stores local tool and prompt definitions. Treat `docs/`, `image/`, and the root design asset folders as references, and `dist/` plus `src-tauri/target/` as generated output.

## Build, Test, and Development Commands
Use `npm install` to install frontend dependencies. Run `npm run dev` for the Vite preview on port `1420`, and `npm run tauri dev` to launch the desktop app with the Rust backend. Use `npm run build` to type-check TypeScript and produce the frontend bundle. Run backend tests with `cargo test --manifest-path src-tauri/Cargo.toml`. The offline license CLI lives under `license_tool/`; inspect it with `cargo run --release --manifest-path license_tool/Cargo.toml -- --help`.

## Coding Style & Naming Conventions
TypeScript runs in `strict` mode, so keep types explicit and avoid `any` unless necessary. Follow the existing style: 2-space indentation in TS/TSX and 4-space indentation in Rust. Use `PascalCase` for React components (`ActivationScreen.tsx`), `camelCase` for functions and hooks, and `snake_case` for Rust files/modules (`command_runner.rs`). Keep Tauri command names descriptive. No repo-wide ESLint or Prettier config is committed, so match surrounding formatting and run `cargo fmt` before submitting Rust changes.

## Testing Guidelines
Backend unit tests currently live in `src-tauri/src/tests.rs` and use Rust's built-in `#[test]` framework. Add tests near the behavior you change and name them by outcome, for example `parses_tool_command_arguments`. There is no committed frontend test harness yet, so UI changes should include manual verification with `npm run tauri dev`, especially for chat, auth, license, and remote relay flows.

## Commit & Pull Request Guidelines
Recent commits use short, task-focused subjects, often in Chinese. Keep commits concise, present tense, and scoped to one change. Pull requests should include a summary of impact, affected areas (`src/`, `src-tauri/`, `control_agent/`), manual test steps, screenshots for visible UI changes, and any `.env`, skill, or model configuration updates. Link the related issue or requirement when one exists.

## Security & Configuration Tips
Keep secrets only in `.env`; commit placeholders to `.env.example`. Do not commit virtualenvs, local caches, or generated binaries. When changing Python helpers or skill integrations, make sure `.skills/*.json`, `control_agent/requirements.txt`, and the referenced script paths stay in sync.
