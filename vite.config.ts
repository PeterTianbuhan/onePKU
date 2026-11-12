import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import demoApi from "./scripts/demo/plugin.mjs";
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
export default defineConfig(({ mode }) => ({
  // `npm run demo`：/api 由虚构数据应答，改界面时不需要登录真实账号。
  plugins: [react(), ...(mode === "demo" ? [demoApi()] : [])],
  clearScreen: false,
  server: { strictPort: true },
  define: { __APP_VERSION__: JSON.stringify(version) },
}));
