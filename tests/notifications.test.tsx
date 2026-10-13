import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  htmlToText,
  NotificationProvider,
  useNotifications,
} from "../src/lib/notifications";
import { openBrowser } from "../src/lib/browser";
vi.mock("../src/lib/browser", () => ({ openBrowser: vi.fn(async () => {}) }));
import Notices from "../src/pages/Notices";
function Probe() {
  const n = useNotifications();
  return (
    <>
      <span>{n.unread} unread</span>
      <span>{n.issues.map((i) => i.source).join(",")}</span>
      {n.items.map((i) => (
        <button
          key={i.key}
          onClick={() => n.markRead([i.key], !n.isRead(i.key))}
        >
          {i.title} {n.isRead(i.key) ? "read" : "new"}
        </button>
      ))}
    </>
  );
}
function mount() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <NotificationProvider>
        <Probe />
      </NotificationProvider>
    </QueryClientProvider>,
  );
}
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});
it("retains working sources when one fails and persists reversible read state across remount", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u, o) => {
      const r = JSON.parse(o.body);
      return {
        ok: true,
        json: async () => ({
          data:
            r.kind === "notices"
              ? []
              : r.source === "dean"
                ? null
                : {
                    items: [
                      {
                        id: "one",
                        title: r.source,
                        date: "2026-09-09",
                        source: r.source,
                        department: r.source,
                      },
                    ],
                    hasMore: false,
                  },
          error:
            r.source === "dean"
              ? { code: "network", message: "offline" }
              : null,
          stale: false,
          warnings: [],
          generation: "test",
          updatedAt: new Date().toISOString(),
        }),
      };
    }),
  );
  let v = mount();
  await screen.findByText("school new");
  await screen.findByText("3 unread");
  expect(screen.getByText("dean")).toBeInTheDocument();
  fireEvent.click(screen.getByText("school new"));
  await screen.findByText("2 unread");
  await waitFor(() =>
    expect(localStorage.getItem("onepku.news.read.v1")).toContain("school:one"),
  );
  v.unmount();
  v = mount();
  await screen.findByText("school read");
  await screen.findByText("2 unread");
  fireEvent.click(screen.getByText("school read"));
  await screen.findByText("3 unread");
});
it("recovers from malformed saved preferences", async () => {
  localStorage.setItem("onepku.news.sources.v1", "{}");
  localStorage.setItem("onepku.news.read.v1", "123");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [],
        error: null,
        stale: false,
        warnings: [],
        generation: "test",
        updatedAt: new Date().toISOString(),
      }),
    })),
  );
  mount();
  expect(screen.getByText("0 unread")).toBeInTheDocument();
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(5));
});
it("subscribes to library activities and opens the original page without replacing existing preferences", async () => {
  localStorage.setItem("onepku.news.sources.v1", '["school"]');
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u, o) => {
      const r = JSON.parse(o.body);
      requests.push(`${r.kind}:${r.source}`);
      return {
        ok: true,
        json: async () => ({
          data:
            r.kind === "newsDetail"
              ? { html: "<p>请自备电脑</p>" }
              : {
                  items:
                    r.source === "library"
                      ? [
                          {
                            id: "lecture-2026",
                            url: "https://www.lib.pku.edu.cn/hdrl/lecture.htm",
                            title: "AI 建模",
                            source: "library",
                            department: "图书馆",
                            date: "2026-09-07",
                            dateLabel: "更新",
                            eventStart: "2026-12-03 15:10",
                            eventEnd: "2026-12-03 16:40",
                            location: "培训教室208+在线",
                            speaker: "安东",
                          },
                        ]
                      : [],
                  hasMore: false,
                },
          error: null,
          stale: false,
          warnings: [],
          generation: "test",
          updatedAt: new Date().toISOString(),
        }),
      };
    }),
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <NotificationProvider>
        <Notices login={() => {}} />
      </NotificationProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(requests).toContain("news:school"));
  expect(requests).not.toContain("news:library");
  fireEvent.click(screen.getByRole("button", { name: "订阅来源" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /图书馆活动/ }));
  await waitFor(() => expect(requests).toContain("news:library"));
  expect(JSON.parse(localStorage.getItem("onepku.news.sources.v1")!)).toEqual([
    "school",
    "library",
  ]);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  fireEvent.click(await screen.findByRole("button", { name: /AI 建模/ }));
  await waitFor(() =>
    expect(openBrowser).toHaveBeenCalledWith(
      "https://www.lib.pku.edu.cn/hdrl/lecture.htm",
      "AI 建模",
    ),
  );
  expect(requests).not.toContain("newsDetail:library");
  expect(screen.getByText(/2026-12-03 15:10/)).toBeInTheDocument();
  await waitFor(() =>
    expect(localStorage.getItem("onepku.news.read.v1")).toContain(
      "library:lecture-2026",
    ),
  );
});

it("htmlToText keeps paragraphs and strips tags, scripts and entities", () => {
  expect(
    htmlToText(
      "<p>第一段&nbsp;<b>加粗</b></p><script>alert(1)</script><p>第二段 &amp; 第三段</p>",
    ),
  ).toBe("第一段 加粗\n\n第二段 & 第三段");
  expect(htmlToText("纯文本")).toBe("纯文本");
  expect(htmlToText("<div><br>只有换行</div>")).toBe("只有换行");
});
