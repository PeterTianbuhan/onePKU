// 检查更新：只在 Tauri 容器内可用；浏览器预览模式下引导到 Releases 页。
export const RELEASES_URL = "https://github.com/PeterTianbuhan/onePKU/releases";
export const APP_VERSION: string = __APP_VERSION__;

export type UpdateInfo = {
  version: string;
  date: string | null;
  notes: string;
  size: number | null;
};
export type UpdateHandle = UpdateInfo & {
  install: (
    onProgress: (done: number, total: number | null) => void,
  ) => Promise<void>;
};

export function inApp(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

/** 返回 null 表示已是最新。 */
export async function checkForUpdate(): Promise<UpdateHandle | null> {
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check({ timeout: 20_000 }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes("platforms") &&
      (message.includes("not found") ||
        message.includes("None of the fallback"))
    ) {
      throw new Error(
        "此版本尚未提供当前系统的更新包，请稍后重试或查看 Releases。",
      );
    }
    throw error;
  });
  if (!update) return null;
  return {
    version: update.version,
    date: update.date ?? null,
    notes: update.body ?? "",
    size: null,
    install: async (onProgress) => {
      let total: number | null = null;
      let done = 0;
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? null;
        else if (e.event === "Progress") {
          done += e.data.chunkLength;
          onProgress(done, total);
        } else if (e.event === "Finished") onProgress(total ?? done, total);
      });
    },
  };
}

export async function relaunchApp(): Promise<void> {
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
