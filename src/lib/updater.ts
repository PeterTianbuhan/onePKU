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

/** 稳定版跟正式 Release；每日构建跟 main 每天自动打的 nightly 预发布。 */
export type UpdateChannel = "stable" | "nightly";
const channelKey = "onepku.updateChannel";
export function readChannel(): UpdateChannel {
  try {
    return localStorage.getItem(channelKey) === "nightly"
      ? "nightly"
      : "stable";
  } catch {
    return "stable";
  }
}
export function saveChannel(channel: UpdateChannel) {
  try {
    localStorage.setItem(channelKey, channel);
  } catch {
    // 存不下就只在这次打开里生效。
  }
}
/** 当前装的是不是每日构建：版本号带 -nightly 后缀。 */
export function isNightly(version = APP_VERSION): boolean {
  return version.includes("-nightly.");
}

/** 返回 null 表示已是最新。按通道由原生端选更新地址，下载安装仍走更新插件。 */
export async function checkForUpdate(
  channel: UpdateChannel = readChannel(),
): Promise<UpdateHandle | null> {
  const [{ invoke }, { Update }] = await Promise.all([
    import("@tauri-apps/api/core"),
    import("@tauri-apps/plugin-updater"),
  ]);
  const metadata = await invoke<ConstructorParameters<typeof Update>[0] | null>(
    "check_update",
    { channel },
  ).catch((error: unknown) => {
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
    // 每日构建每天先删掉旧包再重新上传，中间十几分钟取不到更新清单。
    if (channel === "nightly" && message.includes("valid release JSON")) {
      throw new Error("每日构建正在重新打包，请过一会儿再检查。");
    }
    throw error;
  });
  if (!metadata) return null;
  const update = new Update(metadata);
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
