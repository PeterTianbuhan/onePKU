import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { strictPort: true },
  define: { __APP_VERSION__: JSON.stringify(version) },
});
