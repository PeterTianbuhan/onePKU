import { afterEach, expect, it, vi } from "vitest";
import { searchShortcut, trashName } from "../src/lib/platform";

afterEach(() => vi.restoreAllMocks());
it("uses Windows shortcut and Recycle Bin labels", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  expect(searchShortcut()).toBe("Ctrl K");
  expect(trashName()).toBe("回收站");
});
it("preserves macOS shortcut and Trash labels", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  expect(searchShortcut()).toBe("⌘ K");
  expect(trashName()).toBe("废纸篓");
});
