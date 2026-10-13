import React, { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useReplayFullscreen } from "../src/components/useReplayFullscreen";

const native = vi.hoisted(() => ({
  isFullscreen: vi.fn(),
  setFullscreen: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => native }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

function Player() {
  const frame = useRef<HTMLDivElement>(null);
  const {
    active,
    toggle,
    native: fullscreen,
  } = useReplayFullscreen(frame, () => {});
  return (
    <main>
      <button>课程导航</button>
      <div ref={frame} data-testid="frame" data-fullscreen={fullscreen}>
        <video />
        <button onClick={toggle}>{active ? "退出全屏" : "全屏"}</button>
      </div>
    </main>
  );
}

it(
  "uses the native window, contains focus, and restores the window with Escape",
  { timeout: 10000 },
  async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    native.isFullscreen.mockResolvedValueOnce(false).mockResolvedValue(true);
    native.setFullscreen.mockResolvedValue(undefined);
    render(<Player />);
    fireEvent.click(screen.getByRole("button", { name: "全屏", exact: true }));
    await screen.findByRole("button", { name: "退出全屏" });
    expect(native.setFullscreen).toHaveBeenCalledWith(true);
    expect(screen.getByTestId("frame")).toHaveAttribute(
      "data-fullscreen",
      "true",
    );
    // inert 的加与摘都在 effect 里，比按钮文案晚半拍，要等它落定。
    await waitFor(() =>
      expect((screen.getByText("课程导航") as HTMLElement).inert).toBe(true),
    );
    fireEvent.keyDown(window, { key: "Escape" });
    await screen.findByRole("button", { name: "全屏", exact: true });
    expect(native.setFullscreen).toHaveBeenLastCalledWith(false);
    await waitFor(() =>
      expect((screen.getByText("课程导航") as HTMLElement).inert).not.toBe(
        true,
      ),
    );
  },
);

it(
  "preserves an already fullscreen app on exit and restores on unmount",
  { timeout: 10000 },
  async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    native.isFullscreen.mockResolvedValue(true);
    native.setFullscreen.mockResolvedValue(undefined);
    const player = render(<Player />);
    fireEvent.click(screen.getByRole("button", { name: "全屏", exact: true }));
    await screen.findByRole("button", { name: "退出全屏" });
    player.unmount();
    expect(native.setFullscreen).toHaveBeenLastCalledWith(true);
  },
);

it(
  "removes the player overlay when macOS exits fullscreen",
  { timeout: 10000 },
  async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    native.isFullscreen.mockResolvedValueOnce(false).mockResolvedValue(true);
    native.setFullscreen.mockResolvedValue(undefined);
    render(<Player />);
    fireEvent.click(screen.getByRole("button", { name: "全屏", exact: true }));
    await screen.findByRole("button", { name: "退出全屏" });
    native.isFullscreen.mockResolvedValue(false);
    fireEvent(window, new Event("resize"));
    await waitFor(() =>
      expect(screen.getByTestId("frame")).toHaveAttribute(
        "data-fullscreen",
        "false",
      ),
    );
  },
);
