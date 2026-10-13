import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Settings, { type Session } from "../src/pages/Settings";

type Card = {
  connected: boolean;
  name: string;
  account: string;
  department?: string;
};
function resources(state: {
  connected: boolean;
  department: string;
  source: string;
}) {
  const haoxue: Card = {
    connected: state.connected,
    name: state.connected ? "张三" : "",
    account: state.connected ? "2200070000" : "",
  };
  const portal: Card & { department: string } = {
    connected: state.connected,
    name: state.connected ? "张三" : "",
    account: state.connected ? "2200070000" : "",
    department: state.department,
  };
  return {
    preferences: {
      keepAlive: true,
      downloadRoot: null,
      downloadRootIsDefault: true,
    },
    haoxueStatus: haoxue,
    credentials: {
      stored: state.connected,
      username: state.connected ? "2200070000" : "",
    },
    departments: {
      selected: "",
      detected: state.department,
      effective: state.connected ? state.department : "",
      source: state.connected ? state.source : "",
      options: ["物理学院", "数学科学学院"],
    },
    portalStatus: portal,
    profile: null,
  } as Record<string, unknown>;
}
function mount(node: React.ReactNode) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {node}
    </QueryClientProvider>,
  );
}
const sessions = (state: string): Session[] =>
  (["course", "treehole", "campuscard", "bdkj"] as const).map((service) => ({
    service,
    state,
    generation: "test",
  }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

it("lists every service as one connection card in the Android order", async () => {
  const data = resources({
    connected: true,
    department: "物理学院",
    source: "校内门户",
  });
  const sent: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => {
      const request = JSON.parse(options.body);
      sent.push(request);
      const value =
        request.kind === "portalDetect"
          ? { department: "物理学院" }
          : (data[request.kind] ?? null);
      return {
        ok: true,
        json: async () => ({
          data: value,
          updatedAt: new Date().toISOString(),
          generation: "test",
          error: null,
          warnings: [],
          stale: false,
        }),
      };
    }),
  );
  const login = vi.fn();
  mount(
    <Settings
      login={login}
      sessions={[
        { service: "course", state: "verified", generation: "test" },
        { service: "treehole", state: "saved", generation: "test" },
        { service: "campuscard", state: "expired", generation: "test" },
        { service: "bdkj", state: "missing", generation: "test" },
      ]}
    />,
  );
  const names = await waitFor(() => {
    const cards = [...document.querySelectorAll(".connection h3")];
    expect(cards.length).toBe(5);
    return cards.map((card) => card.textContent);
  });
  expect(names).toEqual(["教学网", "树洞", "校园卡", "校内门户", "课堂实录"]);
  // 状态各归各：会话过期与已保存都不会被糊成「已连接」。
  await waitFor(() => expect(screen.getAllByText("已连接").length).toBe(3));
  expect(screen.getByText("会话已过期")).toBeInTheDocument();
  expect(screen.getByText("会话已保存")).toBeInTheDocument();
  expect(screen.queryByText("尚未连接")).not.toBeInTheDocument();
  // 已连接的服务可以单独断开，不影响其它服务。
  fireEvent.click(screen.getAllByRole("button", { name: "断开" })[0]);
  await waitFor(() =>
    expect(
      sent.some((r) => r.kind === "serviceLogout" && r.service === "course"),
    ).toBe(true),
  );
  // 校内门户已连接时，识别学院就放在它自己的卡片上。
  fireEvent.click(screen.getByRole("button", { name: "识别学院" }));
  await waitFor(() =>
    expect(sent.some((r) => r.kind === "portalDetect")).toBe(true),
  );
  // 本院通知跟着门户识别走，并把来源一起说明白。
  expect(
    await screen.findByText(/当前：物理学院（校内门户）/),
  ).toBeInTheDocument();
  // 未连接的门户不给「识别学院」，课堂实录的连接入口始终在。
  expect(login).not.toHaveBeenCalled();
});

it("keeps disconnected services honest and connectable", async () => {
  const data = resources({ connected: false, department: "", source: "" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => ({
      ok: true,
      json: async () => ({
        data: data[JSON.parse(options.body).kind] ?? null,
        updatedAt: new Date().toISOString(),
        generation: "test",
        error: null,
        warnings: [],
        stale: false,
      }),
    })),
  );
  const login = vi.fn();
  mount(<Settings login={login} sessions={sessions("missing")} />);
  await waitFor(() =>
    expect(document.querySelectorAll(".connection").length).toBe(5),
  );
  expect(screen.getAllByText("尚未连接").length).toBe(5);
  // 没连接就没有「断开」，也不给「识别学院」。
  expect(
    screen.queryByRole("button", { name: "断开" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "识别学院" }),
  ).not.toBeInTheDocument();
  // 「连接」按服务分别走统一身份认证窗口。
  fireEvent.click(screen.getAllByRole("button", { name: "连接" })[0]);
  expect(login).toHaveBeenCalledWith("course");
  // 浏览器预览里打不开原生窗口，课堂实录要如实说明而不是假装有登录页。
  const haoxue = [...document.querySelectorAll(".connection")].find((card) =>
    card.textContent?.includes("课堂实录"),
  );
  expect(haoxue?.textContent).toContain("请在桌面应用中连接课堂实录");
});

it("switches the appearance and remembers the choice", async () => {
  const data = resources({ connected: false, department: "", source: "" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => ({
      ok: true,
      json: async () => ({
        data: data[JSON.parse(options.body).kind] ?? null,
        updatedAt: new Date().toISOString(),
        generation: "test",
        error: null,
        warnings: [],
        stale: false,
      }),
    })),
  );
  mount(<Settings login={vi.fn()} sessions={sessions("missing")} />);
  const group = await screen.findByRole("group", { name: "外观模式" });
  expect(
    within(group).getByRole("button", { name: "跟随系统" }),
  ).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(within(group).getByRole("button", { name: "深色" }));
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(localStorage.getItem("onepku.theme.v1")).toBe("dark");
  fireEvent.click(within(group).getByRole("button", { name: "浅色" }));
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(localStorage.getItem("onepku.theme.v1")).toBe("light");
});
