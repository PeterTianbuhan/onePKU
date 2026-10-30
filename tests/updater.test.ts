import { afterEach, expect, it, vi } from "vitest";
import { checkForUpdate, isNightly } from "../src/lib/updater";
// 原生端 check_update 返回插件 check() 同样的元数据，前端用插件的 Update 包一层。
const mocks = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (_cmd: string, args: { channel: string }) => mocks.check(args),
}));
vi.mock("@tauri-apps/plugin-updater", () => ({
  Update: class {
    version: string;
    date?: string;
    body?: string;
    downloadAndInstall: unknown;
    constructor(m: {
      version: string;
      date?: string;
      body?: string;
      downloadAndInstall: unknown;
    }) {
      this.version = m.version;
      this.date = m.date;
      this.body = m.body;
      this.downloadAndInstall = m.downloadAndInstall;
    }
  },
}));
afterEach(() => vi.resetAllMocks());
it("returns null only when the updater reports no newer version", async () => {
  mocks.check.mockResolvedValue(null);
  expect(await checkForUpdate()).toBeNull();
  expect(mocks.check).toHaveBeenCalledWith({ channel: "stable" });
});
it("explains a missing platform package instead of claiming the app is current", async () => {
  for (const error of [
    "the platform `windows-x86_64` was not found in the response `platforms` object",
    'None of the fallback platforms `["windows-x86_64-nsis", "windows-x86_64"]` were found in the response `platforms` object',
  ]) {
    mocks.check.mockRejectedValue(error);
    await expect(checkForUpdate()).rejects.toThrow("尚未提供当前系统的更新包");
  }
});
it("propagates network errors without saying latest", async () => {
  mocks.check.mockRejectedValue(new Error("offline"));
  await expect(checkForUpdate()).rejects.toThrow("offline");
});
it("preserves progress and signature failures from the native installer", async () => {
  const downloadAndInstall = vi.fn(async (progress) => {
    progress({ event: "Started", data: { contentLength: 100 } });
    progress({ event: "Progress", data: { chunkLength: 40 } });
    progress({ event: "Progress", data: { chunkLength: 60 } });
    progress({ event: "Finished" });
  });
  mocks.check.mockResolvedValue({
    version: "0.1.1",
    body: "notes",
    downloadAndInstall,
  });
  const update = await checkForUpdate();
  const progress = vi.fn();
  await update!.install(progress);
  expect(progress.mock.calls).toEqual([
    [40, 100],
    [100, 100],
    [100, 100],
  ]);
  downloadAndInstall.mockRejectedValue(new Error("invalid signature"));
  await expect(update!.install(progress)).rejects.toThrow("invalid signature");
});
it("asks the native side for the chosen channel", async () => {
  mocks.check.mockResolvedValue(null);
  await checkForUpdate("nightly");
  expect(mocks.check).toHaveBeenCalledWith({ channel: "nightly" });
});
it("explains a missing nightly feed while it is being rebuilt", async () => {
  mocks.check.mockRejectedValue(
    "Could not fetch a valid release JSON from the remote",
  );
  await expect(checkForUpdate("nightly")).rejects.toThrow("重新打包");
});
it("recognises nightly builds by their version suffix", () => {
  expect(isNightly("0.12.4-nightly.202610301209")).toBe(true);
  expect(isNightly("0.12.3")).toBe(false);
});
