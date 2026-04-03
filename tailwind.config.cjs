// Tailwind CSS 配置文件。
// 用于声明需要扫描的模板路径，以及主题扩展入口。
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {},
  },
  plugins: [],
};
