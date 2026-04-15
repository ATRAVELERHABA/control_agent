//! Tauri 后端库入口。

mod activation;
mod auth;
mod app;
mod assets;
mod audio;
mod command_runner;
mod constants;
mod env;
mod events;
pub mod licensing;
mod llm;
mod logging;
mod models;
mod python;
mod search;
mod skills;
mod vision;

#[cfg(test)]
mod tests;

pub use app::run;
