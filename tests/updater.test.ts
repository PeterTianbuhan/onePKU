import { afterEach, expect, it, vi } from "vitest";
import { checkForUpdate } from "../src/lib/updater";
const mocks = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
afterEach(() => vi.resetAllMocks());
it("returns null only when the updater reports no newer version", async () => {
  mocks.check.mockResolvedValue(null);
  expect(await checkForUpdate()).toBeNull();
  expect(mocks.check).toHaveBeenCalledWith({ timeout: 20_000 });
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
