//! Tauri 后端库入口。

mod activation;
mod app;
mod assets;
mod audio;
mod auth;
mod command_runner;
mod constants;
mod dingtalk;
mod env;
mod events;
mod history;
pub mod licensing;
mod llm;
mod logging;
mod models;
mod python;
mod search;
mod settings;
mod skills;
mod vision;

#[cfg(test)]
mod tests;

pub use app::run;
