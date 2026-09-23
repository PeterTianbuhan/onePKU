import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import ReplayPlayer from "../src/components/ReplayPlayer";

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue(
    "probably",
  );
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});
it("plays a loopback stream, resumes position, controls cache, and closes without opening another app", async () => {
  const requests: Record<string, unknown>[] = [];
  let downloading = false;
  localStorage.setItem("onepku.playback.account.1.abc", "42");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => {
      const request = JSON.parse(options.body);
      requests.push(request);
      if (request.kind === "playbackControl") downloading = request.downloading;
      const status = {
        completed: 3,
        segments: 719,
        bytes: 1000000,
        complete: false,
        downloading,
        offline: false,
        message: "",
      };
      return {
        ok: true,
        json: async () => ({
          data:
            request.kind === "playbackPrepare"
              ? {
                  id: "session",
                  url: "http://127.0.0.1:4567/media/token/index.m3u8",
                  title: "Lecture",
                  duration: 300,
                  status,
                }
              : status,
          error: null,
          stale: false,
          warnings: [],
          generation: "account",
          updatedAt: new Date().toISOString(),
        }),
      };
    }),
  );
  const mounted = render(
    <ReplayPlayer
      course="1"
      video={{
        title: "Lecture",
        time: "2026-09-08",
        url: "https://onlineroomse.pku.edu.cn/livingroom",
        hash_id: "abc",
      }}
      generation="account"
      close={() => {}}
    />,
  );
  const video = screen.getByLabelText("Lecture 视频") as HTMLVideoElement;
  await waitFor(() =>
    expect(video.src).toBe("http://127.0.0.1:4567/media/token/index.m3u8"),
  );
  expect(video.controls).toBe(false);
  expect(requests).toContainEqual({
    kind: "playbackPrepare",
    course: "1",
    video: "abc",
    refresh: false,
    position: 42,
  });
  // Loading a source emits timeupdate/pause at zero before metadata arrives.
  // Those events must not overwrite the saved resume position.
  fireEvent.timeUpdate(video);
  fireEvent.pause(video);
  expect(localStorage.getItem("onepku.playback.account.1.abc")).toBe("42");
  fireEvent.loadedMetadata(video);
  expect(video.currentTime).toBe(42);
  expect(video.play).toHaveBeenCalled();
  Object.defineProperty(video, "paused", {
    configurable: true,
    get: () => false,
  });
  fireEvent.play(video);
  fireEvent.click(screen.getByRole("button", { name: "暂停", exact: true }));
  expect(video.pause).toHaveBeenCalled();
  fireEvent.pause(video);
  expect(
    screen.getByRole("button", { name: "播放", exact: true }),
  ).toBeEnabled();
  fireEvent.change(screen.getByRole("slider", { name: "音量" }), {
    target: { value: "0.25" },
  });
  fireEvent.volumeChange(video);
  expect(video.volume).toBe(0.25);
  fireEvent.click(screen.getByRole("button", { name: "静音", exact: true }));
  fireEvent.volumeChange(video);
  expect(video.muted).toBe(true);
  expect(screen.getByRole("button", { name: "取消静音" })).toBeEnabled();
  fireEvent.keyDown(video, { key: "ArrowRight" });
  expect(video.currentTime).toBe(52);
  fireEvent.keyDown(video, { key: "ArrowLeft" });
  expect(video.currentTime).toBe(42);
  fireEvent.click(screen.getByRole("button", { name: "更多播放选项" }));
  expect(
    screen.getByText("已缓存 0.4%（3 / 719 个分片）", { exact: false }),
  ).toBeInTheDocument();
  fireEvent.click(await screen.findByRole("button", { name: "暂停整节缓存" }));
  await waitFor(() =>
    expect(requests).toContainEqual({
      kind: "playbackControl",
      id: "session",
      downloading: false,
    }),
  );
  fireEvent.change(screen.getByRole("combobox", { name: "播放速度" }), {
    target: { value: "1.5" },
  });
  expect(video.playbackRate).toBe(1.5);
  fireEvent.click(screen.getByRole("button", { name: "快进 10 秒" }));
  expect(video.currentTime).toBe(52);
  fireEvent.timeUpdate(video);
  expect(localStorage.getItem("onepku.playback.account.1.abc")).toBe("52");
  expect(
    requests.some((r) => r.kind === "openLink" || r.kind === "downloadVideo"),
  ).toBe(false);
  mounted.unmount();
  await waitFor(() =>
    expect(requests).toContainEqual({ kind: "playbackClose", id: "session" }),
  );
});
it("closes a late preparation after the viewer has left", async () => {
  let resolve: (value: unknown) => void = () => {};
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => {
      const r = JSON.parse(options.body);
      requests.push(r);
      if (r.kind === "playbackPrepare")
        return new Promise((done) => {
          resolve = done;
        });
      return { ok: true, json: async () => ({ data: {}, error: null }) };
    }),
  );
  const mounted = render(
    <ReplayPlayer
      course="1"
      video={{
        title: "Lecture",
        time: "",
        url: "https://course.pku.edu.cn",
        hash_id: "abc",
      }}
      generation="account"
      close={() => {}}
    />,
  );
  mounted.unmount();
  resolve({
    ok: true,
    json: async () => ({
      data: { id: "late", status: { complete: false } },
      error: null,
    }),
  });
  await waitFor(() =>
    expect(requests).toContainEqual({ kind: "playbackClose", id: "late" }),
  );
  expect(requests.some((r) => r.kind === "playbackControl")).toBe(false);
});
