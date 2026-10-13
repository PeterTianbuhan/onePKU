import React, { useRef } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SubtitleSettings from "../src/components/SubtitleSettings";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  SubtitleControls,
  useReplaySubtitles,
  useSubtitleTrack,
  type SubtitleCue,
} from "../src/components/ReplaySubtitles";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("keeps subtitle installation optional and refreshes after external setup without triggering downloads", async () => {
  let installed = false;
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => {
      requests.push(JSON.parse(options.body).kind);
      return {
        ok: true,
        json: async () => ({
          data: {
            available: installed,
            model: "belle-zh",
            custom: false,
            models: [
              { id: "belle-zh", label: "Belle 中文", hint: "中文课程模型" },
            ],
          },
        }),
      };
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SubtitleSettings />
    </QueryClientProvider>,
  );
  expect(await screen.findByText(/尚未安装.*仍可/)).toBeInTheDocument();
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("按需安装本机字幕"));
  expect(screen.getByText("bash scripts/subtitles/install.sh")).toBeVisible();
  installed = true;
  fireEvent.click(screen.getByRole("button", { name: "安装后刷新" }));
  expect(await screen.findByRole("combobox", { name: "识别模型" })).toHaveValue(
    "belle-zh",
  );
  expect(requests).toEqual(["subtitleSettings", "subtitleSettings"]);
  client.clear();
});
it("loads saved native cues, applies an offset, and disables them without changing their text", () => {
  const track = {
    mode: "disabled",
    cues: [] as { startTime: number; endTime: number; text: string }[],
    addCue(cue: { startTime: number; endTime: number; text: string }) {
      this.cues.push(cue);
    },
    removeCue(cue: unknown) {
      this.cues = this.cues.filter((item) => item !== cue);
    },
  };
  vi.spyOn(HTMLMediaElement.prototype, "addTextTrack").mockReturnValue(
    track as unknown as TextTrack,
  );
  vi.stubGlobal(
    "VTTCue",
    class {
      constructor(
        public startTime: number,
        public endTime: number,
        public text: string,
      ) {}
    },
  );
  const cues = [{ start: 1, end: 3, text: "x < y & 中文" }];
  function Harness({
    enabled,
    offset,
    cues,
  }: {
    enabled: boolean;
    offset: number;
    cues: SubtitleCue[];
  }) {
    const video = useRef<HTMLVideoElement>(null);
    useSubtitleTrack(video, cues, enabled, offset);
    return <video ref={video} />;
  }
  const view = render(<Harness enabled offset={0.5} cues={cues} />);
  expect(track.mode).toBe("showing");
  expect(track.cues).toEqual([
    { startTime: 1.5, endTime: 3.5, text: "x &lt; y &amp; 中文" },
  ]);
  view.rerender(<Harness enabled={false} offset={-2} cues={cues} />);
  expect(track.mode).toBe("disabled");
  expect(track.cues[0].startTime).toBe(0);
  expect(track.cues[0].endTime).toBe(1);
  expect(HTMLMediaElement.prototype.addTextTrack).toHaveBeenCalledTimes(1);
  view.rerender(
    <Harness
      enabled
      offset={0}
      cues={[...cues, { start: 60, end: 63, text: "下一段" }]}
    />,
  );
  expect(track.cues).toHaveLength(2);
  expect(track.cues[1].startTime).toBe(60);
  expect(track.mode).toBe("showing");
  expect(HTMLMediaElement.prototype.addTextTrack).toHaveBeenCalledTimes(1);
  view.rerender(<Harness enabled offset={0} cues={[]} />);
  expect(track.cues).toHaveLength(0);
});

it("offers generation and cancellation while retaining saved subtitles", async () => {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => {
      const request = JSON.parse(options.body);
      requests.push(request.kind);
      return {
        ok: true,
        json: async () => ({
          error: null,
          data: {
            available: true,
            provider: "本机模型",
            job: {
              state:
                request.kind === "subtitleStart"
                  ? "transcribing"
                  : request.kind === "subtitleCancel"
                    ? "cancelled"
                    : "ready",
            },
            document: {
              source: "已保存",
              cues: [{ start: 1, end: 3, text: "已有字幕" }],
            },
          },
        }),
      };
    }),
  );
  function Harness() {
    const state = useReplaySubtitles("session");
    return (
      <SubtitleControls
        id="session"
        state={state}
        enabled
        setEnabled={() => {}}
        offset={0}
        setOffset={() => {}}
      />
    );
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "字幕选项" }));
  await screen.findByRole("checkbox", { name: "显示字幕" });
  expect(
    screen.queryByRole("button", { name: "导入 SRT / VTT" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("spinbutton", { name: "字幕延迟秒数" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "字幕更多选项" }));
  expect(
    screen.getByRole("spinbutton", { name: "字幕延迟秒数" }),
  ).toBeInTheDocument();
  fireEvent.click(await screen.findByRole("button", { name: "重新生成" }));
  fireEvent.click(await screen.findByRole("button", { name: "停止生成" }));
  await waitFor(() => expect(requests).toContain("subtitleCancel"));
  expect(screen.getByRole("checkbox", { name: "显示字幕" })).toBeChecked();
  expect(requests).toEqual([
    "subtitleStatus",
    "subtitleStart",
    "subtitleCancel",
  ]);
});

it("offers resume after reopening a partial track, including a silent completed prefix", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: {
          available: true,
          provider: "本机模型",
          job: { state: "partial" },
          document: {
            source: "本机模型",
            cues: [],
            progress: { completed: 120, total: 7200 },
          },
        },
      }),
    })),
  );
  function Harness() {
    const state = useReplaySubtitles("reopened");
    return (
      <SubtitleControls
        id="reopened"
        state={state}
        enabled
        setEnabled={() => {}}
        offset={0}
        setOffset={() => {}}
      />
    );
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "字幕选项" }));
  expect(await screen.findByRole("button", { name: "继续生成" })).toBeEnabled();
  expect(screen.getByRole("status")).toHaveTextContent("已生成 2:00");
  expect(
    screen.queryByRole("button", { name: "导入 SRT / VTT" }),
  ).not.toBeInTheDocument();
});

it("does not offer the macOS subtitle installer on Windows", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: {
          available: false,
          nativeInstallSupported: false,
          custom: false,
          model: "custom",
          models: [],
          setupMessage: "此平台暂不提供内置字幕识别模型；仍可导入 SRT / VTT。",
        },
      }),
    })),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SubtitleSettings />
    </QueryClientProvider>,
  );
  expect(
    await screen.findByText(/此平台暂不提供内置字幕识别模型/),
  ).toBeVisible();
  expect(
    screen.queryByText("bash scripts/subtitles/install.sh"),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  expect(screen.getByText(/已有字幕继续保留/)).toBeVisible();
  client.clear();
});
