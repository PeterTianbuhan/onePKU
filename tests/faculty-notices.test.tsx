import React from "react";
import { afterEach, it, expect, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NotificationProvider } from "../src/lib/notifications";
import { planIndex } from "../src/lib/curriculum";
import Notices from "../src/pages/Notices";
import { openBrowser } from "../src/lib/browser";
vi.mock("../src/lib/browser", () => ({ openBrowser: vi.fn(async () => {}) }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it("uses the curriculum school, opens real notice URLs, and keeps portal pagination explicit", async () => {
  localStorage.setItem("onepku.news.sources.v1", "[]");
  const plan = planIndex.find((p) => p.school === "物理学院")!;
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u, o) => {
      const r = JSON.parse(o.body);
      requests.push(r);
      return {
        ok: true,
        json: async () => ({
          data:
            r.kind === "profile"
              ? { planId: plan.id }
              : {
                  items:
                    r.school === "物理学院"
                      ? [
                          {
                            id: "1",
                            title: "本科教学公开通知",
                            date: "2026-09-26",
                            department: r.school,
                            source: "faculty",
                            url: "https://cs.pku.edu.cn/info/1001/12345.htm",
                          },
                        ]
                      : [],
                  origin: r.school === "物理学院" ? "学院官网" : "门户部门通知",
                  hasMore: r.school !== "物理学院",
                },
          generation: "public",
          warnings: [],
          error: null,
          stale: false,
          updatedAt: null,
        }),
      };
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NotificationProvider>
        <Notices login={() => {}} />
      </NotificationProvider>
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByLabelText("通知来源"), {
    target: { value: "faculty" },
  });
  fireEvent.click(
    await screen.findByRole("button", { name: /本科教学公开通知/ }),
  );
  expect(openBrowser).toHaveBeenCalledWith(
    "https://cs.pku.edu.cn/info/1001/12345.htm",
    "本科教学公开通知",
  );
  fireEvent.change(screen.getByLabelText("通知院系"), {
    target: { value: "法学院" },
  });
  expect(
    await screen.findByText("当前页没有匹配的本院通知"),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "查看更早通知" }));
  await waitFor(() =>
    expect(
      requests.some(
        (r) =>
          r.kind === "facultyNews" && r.school === "法学院" && r.page === 2,
      ),
    ).toBe(true),
  );
  expect(localStorage.getItem("onepku.news.faculty.v1")).toBe("法学院");
});
