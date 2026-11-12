import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { call, type Envelope, type Request } from "./lib/api";
import { NotificationProvider } from "./lib/notifications";
import { applyTheme, savedTheme } from "./lib/theme";
import { isMacOS } from "./lib/platform";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/shell.css";
import "./styles/controls.css";
import "./styles/pages.css";
import "./styles/course.css";
import "./styles/curriculum.css";
import "./styles/replay.css";
import "./styles/search.css";
// macOS 桌面版的标题栏与内容融合（见 tauri.macos.conf.json），侧栏要给红绿灯让位。
if ("__TAURI_INTERNALS__" in window && isMacOS())
  document.documentElement.dataset.chrome = "overlay";
// 先定主题再画第一帧，避免浅色闪一下再变深。
applyTheme(savedTheme());
const client = new QueryClient();
async function start() {
  try {
    const snapshot = await call<
      { request: Request; envelope: Envelope<unknown> }[]
    >({ kind: "snapshot" });
    for (const row of snapshot.data ?? [])
      client.setQueryData(["resource", row.request], row.envelope, {
        updatedAt: Date.parse(row.envelope.updatedAt ?? "") || 0,
      });
  } catch {
    /* A failed snapshot does not block live resources. */
  }
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <QueryClientProvider client={client}>
        <NotificationProvider>
          <App />
        </NotificationProvider>
      </QueryClientProvider>
    </React.StrictMode>,
  );
}
void start();
