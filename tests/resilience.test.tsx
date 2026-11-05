import React from "react";
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Resource, Modal } from "../src/components/ui";
import { useResource } from "../src/lib/api";
const env = (data: unknown, error: unknown = null, stale = false) => ({
  data,
  error,
  stale,
  warnings: [],
  updatedAt: "2026-09-09T03:00:00Z",
  generation: "test",
});
function Module({
  kind,
  service,
  login = () => {},
}: {
  kind: string;
  service?: "treehole";
  login?: (service: "treehole") => void;
}) {
  const q = useResource<string>({ kind });
  return (
    <Resource title={kind} q={q} login={login} service={service}>
      {(v) => <p>{v}</p>}
    </Resource>
  );
}
function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {children}
    </QueryClientProvider>
  );
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("independent campus resources", () => {
  it("keeps a working module usable when another fails, and refreshes only its target", async () => {
    const fetch = vi.fn(async (_url, options) => {
      const { kind } = JSON.parse(options.body);
      return {
        ok: true,
        json: async () =>
          kind === "课表"
            ? env(null, { code: "auth", message: "需要登录" })
            : env("余额 123.45"),
      };
    });
    vi.stubGlobal("fetch", fetch);
    render(
      <Wrapper>
        <Module kind="课表" />
        <Module kind="余额" />
      </Wrapper>,
    );
    expect(await screen.findByText("余额 123.45")).toBeInTheDocument();
    expect(await screen.findByText("需要登录")).toBeInTheDocument();
    fetch.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "刷新余额" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetch.mock.calls[0][1].body).kind).toBe("余额");
  });
  it("labels retained data after refresh failure without displaying an empty state", async () => {
    let count = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () =>
          ++count === 1
            ? env("之前的通知")
            : env("之前的通知", { code: "timeout", message: "超时" }, true),
      })),
    );
    render(
      <Wrapper>
        <Module kind="通知" />
      </Wrapper>,
    );
    await screen.findByText("之前的通知");
    fireEvent.click(screen.getByRole("button", { name: "刷新通知" }));
    expect(
      await screen.findByText("更新失败，当前显示上次数据。"),
    ).toBeInTheDocument();
    expect(screen.getByText("之前的通知")).toBeInTheDocument();
    expect(screen.queryByText("没有数据")).not.toBeInTheDocument();
  });
  it("keeps the last data on screen when login has expired", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () =>
          env(
            "上次的成绩",
            { code: "auth", message: "登录已失效，请重新登录" },
            true,
          ),
      })),
    );
    const login = vi.fn();
    render(
      <Wrapper>
        <Module kind="成绩" service="treehole" login={login} />
      </Wrapper>,
    );
    expect(await screen.findByText("上次的成绩")).toBeInTheDocument();
    expect(
      screen.getByText("登录已失效，请重新登录 下面仍是上次的数据。"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新登录" }));
    expect(login).toHaveBeenCalledWith("treehole", undefined);
  });
  it("keeps query results scoped to the requested search", async () => {
    let finish: (v: unknown) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u, o) => {
        const k = JSON.parse(o.body).kind;
        return k === "old"
          ? new Promise((r) => {
              finish = r;
            })
          : { ok: true, json: async () => env("新结果") };
      }),
    );
    const client = new QueryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <Module kind="old" />
      </QueryClientProvider>,
    );
    view.rerender(
      <QueryClientProvider client={client}>
        <Module kind="new" />
      </QueryClientProvider>,
    );
    await screen.findByText("新结果");
    finish({ ok: true, json: async () => env("过时结果") });
    await waitFor(() =>
      expect(screen.queryByText("过时结果")).not.toBeInTheDocument(),
    );
  });
});
it("closes an accessible modal with Escape", async () => {
  const close = vi.fn();
  render(
    <Modal title="附件详情" open onClose={close}>
      <button>下载</button>
    </Modal>,
  );
  expect(screen.getByRole("dialog", { name: "附件详情" })).toBeInTheDocument();
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
});
