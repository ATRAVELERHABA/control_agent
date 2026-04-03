// 前端主入口文件。
// 这个文件的职责很简单：
// 1. 引入全局样式
// 2. 引入根组件 App
// 3. 把 React 应用挂载到 index.html 中的 #root 节点
import React from "react";
import ReactDOM from "react-dom/client";
import "antd/dist/reset.css";
import App from "./App";
import "./index.css";

// createRoot 会创建 React 18 的根节点。
// 在 Tauri 中，最终显示在桌面窗口里的就是这里挂载出来的页面。
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
