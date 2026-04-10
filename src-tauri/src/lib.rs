//! Tauri 后端库入口。

mod app;
mod assets;
mod audio;
mod command_runner;
mod constants;
mod env;
mod events;
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
