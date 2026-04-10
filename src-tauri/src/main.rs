//! 桌面程序入口文件。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// 入口函数只负责把控制权交给库侧启动器。
fn main() {
    ai_universal_assistant_lib::run();
}
