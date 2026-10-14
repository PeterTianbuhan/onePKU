import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Courses from "../src/pages/Courses";
import { pageLink, readLocation } from "../src/lib/navigation";

const replay = {
  hash_id: "lecture",
  title: "视觉艺术回放",
  time: "2026-09-21",
  url: "https://example.test/replay",
};
const videosKey = ["resource", { kind: "courseVideos", course: "art" }];
const envelope = (data: unknown, generation = "account") => ({
  data,
  generation,
  error: null,
  warnings: [],
  stale: false,
  updatedAt: null,
});

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
  history.replaceState(null, "", "/");
  localStorage.clear();
});
function mount(video?: string, source = "course") {
  history.replaceState(
    null,
    "",
    `/#${encodeURIComponent(
      pageLink("课程", {
        course: "art",
        tab: "videos",
        source,
        ...(video ? { video } : {}),
      }),
    )}`,
  );
  const requests: { kind: string; video?: string }[] = [];
  const status = {
    completed: 1,
    segments: 1,
    bytes: 100,
    complete: true,
    downloading: false,
    offline: false,
    message: "",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => {
      const request = JSON.parse(options.body);
      requests.push(request);
      const data =
        request.kind === "allCourses"
          ? [{ id: "art", name: "视觉艺术与计算美学" }]
          : request.kind === "haoxueStatus"
            ? { connected: false }
            : request.kind === "courseVideos" || request.kind === "videos"
              ? [replay]
              : request.kind === "playbackPrepare"
                ? {
                    id: "session",
                    url: "http://127.0.0.1:4567/media/test/index.m3u8",
                    duration: 7200,
                    title: replay.title,
                    status,
                  }
                : request.kind === "playbackStatus"
                  ? status
                  : {};
      return { ok: true, json: async () => envelope(data) };
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Courses login={() => {}} />
    </QueryClientProvider>,
  );
  return { client, requests };
}
async function readyPlayer() {
  const video = (await screen.findByLabelText(
    `${replay.title} 视频`,
  )) as HTMLVideoElement;
  await waitFor(() => expect(video.src).toContain("/media/test/index.m3u8"));
  return video;
}

it("keeps the active media element, position and session when the replay list refreshes", async () => {
  const { client, requests } = mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "播放", exact: true }),
  );
  const video = await readyPlayer();
  fireEvent.loadedMetadata(video);
  video.currentTime = 1830;
  fireEvent.timeUpdate(video);
  await act(async () => {
    client.setQueryData(
      videosKey,
      envelope([{ ...replay, title: "更新后的回放标题" }]),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(screen.queryByLabelText(`${replay.title} 视频`)).toBe(video);
  expect(video.currentTime).toBe(1830);
  expect(requests.filter((r) => r.kind === "playbackPrepare")).toHaveLength(1);
  expect(requests.filter((r) => r.kind === "playbackClose")).toHaveLength(0);
  expect(readLocation().params.get("video")).toBe("lecture");
});

it("retains a deep-linked replay during an incomplete list refresh, then explicitly closes it", async () => {
  const { client, requests } = mount("lecture");
  const video = await readyPlayer();
  await act(async () => {
    client.setQueryData(videosKey, envelope([]));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(screen.queryByLabelText(`${replay.title} 视频`)).toBe(video);
  fireEvent.click(screen.getByRole("button", { name: "关闭播放器" }));
  await waitFor(() =>
    expect(requests.filter((r) => r.kind === "playbackClose")).toHaveLength(1),
  );
  expect(readLocation().params.get("video")).toBeNull();
  expect(
    screen.queryByLabelText(`${replay.title} 视频`),
  ).not.toBeInTheDocument();
});

it("closes playback when navigation removes the selected replay", async () => {
  const { requests } = mount("lecture");
  await readyPlayer();
  await act(async () => {
    history.replaceState(
      null,
      "",
      `/#${encodeURIComponent(
        pageLink("课程", { course: "art", tab: "videos" }),
      )}`,
    );
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await waitFor(() =>
    expect(requests.filter((r) => r.kind === "playbackClose")).toHaveLength(1),
  );
  expect(
    screen.queryByLabelText(`${replay.title} 视频`),
  ).not.toBeInTheDocument();
});

it("does not retain the previous account's replay after an account change", async () => {
  const { client, requests } = mount("lecture");
  await readyPlayer();
  await act(async () => {
    client.setQueryData(videosKey, envelope([], "another-account"));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(
    screen.queryByLabelText(`${replay.title} 视频`),
  ).not.toBeInTheDocument();
  expect(requests.filter((r) => r.kind === "playbackClose")).toHaveLength(1);
});

it("plays teaching-network replays without requiring a separate classroom connection", async () => {
  const { requests } = mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "播放", exact: true }),
  );
  await readyPlayer();
  expect(
    screen.queryByRole("button", { name: "连接课堂实录" }),
  ).not.toBeInTheDocument();
  expect(requests).toContainEqual({ kind: "courseVideos", course: "art" });
  expect(requests.some((r) => r.kind === "videos")).toBe(false);
});

it("prefers the more complete classroom catalog without a separate login gate", async () => {
  const { requests } = mount(undefined, "");
  fireEvent.click(
    await screen.findByRole("button", { name: "播放", exact: true }),
  );
  await readyPlayer();
  expect(requests).toContainEqual({
    kind: "videos",
    course: "视觉艺术与计算美学",
  });
  expect(
    screen.queryByRole("button", { name: "连接课堂实录" }),
  ).not.toBeInTheDocument();
});

it("lets the user use teaching-network replays when classroom authorization is unavailable", async () => {
  const { client } = mount(undefined, "");
  await screen.findByRole("button", { name: "播放", exact: true });
  await act(async () => {
    client.setQueryData(
      ["resource", { kind: "videos", course: "视觉艺术与计算美学" }],
      {
        ...envelope(null),
        error: { code: "haoxueAuth", message: "课堂实录授权需要补充验证" },
      },
    );
  });
  await screen.findByRole("button", { name: "连接课堂实录" });
  fireEvent.click(screen.getByRole("button", { name: "查看教学网回放" }));
  await screen.findByRole("button", { name: "播放", exact: true });
  expect(
    screen.queryByRole("button", { name: "连接课堂实录" }),
  ).not.toBeInTheDocument();
});
