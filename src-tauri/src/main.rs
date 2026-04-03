// Rust 原生入口文件。
// 桌面应用启动后，会先进入这里，再转交给 lib.rs 中的 run 函数继续初始化 Tauri。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 这里不直接写复杂逻辑，而是把启动逻辑集中到 lib.rs 中管理。
    // 这样 main.rs 保持极简，后端核心逻辑也更容易复用和维护。
    ai_universal_assistant_lib::run();
}
