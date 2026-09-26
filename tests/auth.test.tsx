import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Auth from "../src/components/Auth";
import type { LoginTarget } from "../src/lib/api";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  invoke.mockReset();
});

function mount(
  scope?: "treehole",
  service: LoginTarget = "course",
  onClose = vi.fn(),
) {
  const kinds: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      kinds.push(body.kind);
      const data =
        body.kind === "authBegin"
          ? { id: "q1", qr: "data:image/png;base64,AA==" }
          : body.kind === "authPoll"
            ? { state: "pending" }
            : { ok: true };
      return {
        ok: true,
        json: async () => ({
          data,
          error: null,
          warnings: [],
          stale: false,
          generation: "t",
          updatedAt: "",
        }),
      };
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Auth service={service} scope={scope} onClose={onClose} />
    </QueryClientProvider>,
  );
  return kinds;
}

it("opens password login first and fetches the QR immediately on switching", async () => {
  const kinds = mount();
  expect(screen.getByLabelText("统一身份认证密码")).toHaveAttribute(
    "type",
    "password",
  );
  expect(kinds).not.toContain("authBegin");
  fireEvent.click(screen.getByRole("button", { name: "扫码登录" }));
  expect(await screen.findByAltText("教学网登录二维码")).toHaveAttribute(
    "src",
    "data:image/png;base64,AA==",
  );
  expect(kinds).toContain("authBegin");
  expect(
    screen.queryByRole("button", { name: "获取登录二维码" }),
  ).not.toBeInTheDocument();
});

function enterCredentials() {
  fireEvent.change(screen.getByLabelText("学号 / 职工号"), {
    target: { value: "20260001" },
  });
  fireEvent.change(screen.getByLabelText("统一身份认证密码"), {
    target: { value: "synthetic-test-password" },
  });
}
function native() {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
}

it("connects all services once and retries only the failed service without leaving the dialog", async () => {
  const close = vi.fn();
  mount(undefined, "all", close);
  native();
  let treeAttempts = 0;
  invoke.mockImplementation(async (command, args) => {
    if (command !== "login_password") return {};
    const success = args.service !== "treehole" || ++treeAttempts > 1;
    return {
      service: args.service,
      success,
      message: success ? null : "需要动态口令",
    };
  });
  enterCredentials();
  expect(screen.getByLabelText("记住密码，会话过期时自动重登")).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "登录并连接" }));
  const retry = await screen.findByRole("button", { name: "重试未连接的服务" });
  await waitFor(() => expect(retry).toBeEnabled());
  expect(screen.getAllByText("已连接")).toHaveLength(2);
  expect(screen.getByText("需要动态口令")).toBeInTheDocument();
  expect(close).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("当前动态口令"), {
    target: { value: "123456" },
  });
  fireEvent.click(retry);
  expect(await screen.findByRole("button", { name: "完成" })).toBeEnabled();
  expect(
    invoke.mock.calls
      .filter(([c]) => c === "login_password")
      .map(([, args]) => args.service),
  ).toEqual(["course", "treehole", "campuscard", "treehole"]);
  expect(invoke.mock.calls.at(-1)?.[1]).toMatchObject({
    otp: "123456",
    remember: true,
  });
  expect(screen.queryByLabelText("统一身份认证密码")).not.toBeInTheDocument();
});

it("blocks dismissal and duplicate submission while connecting, then allows completion", async () => {
  const close = vi.fn();
  mount(undefined, "course", close);
  native();
  let resolve!: (value: unknown) => void;
  invoke.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  enterCredentials();
  fireEvent.click(screen.getByLabelText("记住密码，会话过期时自动重登"));
  fireEvent.submit(screen.getByLabelText("学号 / 职工号").closest("form")!);
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("button", { name: "关闭" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "扫码登录" })).toBeDisabled();
  fireEvent.submit(screen.getByLabelText("学号 / 职工号").closest("form")!);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke.mock.calls[0][1].remember).toBe(false);
  expect(close).not.toHaveBeenCalled();
  await act(async () => resolve({ service: "course", success: true }));
  fireEvent.click(await screen.findByRole("button", { name: "完成" }));
  expect(close).toHaveBeenCalledTimes(1);
});

it("does not send passwords to the browser preview API or persist them in browser storage", async () => {
  const kinds = mount();
  const storage = vi.spyOn(Storage.prototype, "setItem");
  enterCredentials();
  fireEvent.click(screen.getByRole("button", { name: "登录并连接" }));
  expect(
    await screen.findByText(/浏览器预览可使用扫码登录/),
  ).toBeInTheDocument();
  expect(kinds).toEqual([]);
  expect(storage).not.toHaveBeenCalled();
  storage.mockRestore();
});

it("cancels a QR request that finishes after switching back to password login", async () => {
  const kinds = mount();
  let resolve!: (response: unknown) => void;
  vi.mocked(fetch).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "扫码登录" }));
  fireEvent.click(screen.getByRole("button", { name: "账号密码" }));
  await act(async () =>
    resolve({
      ok: true,
      json: async () => ({
        data: { id: "late-qr", qr: "data:image/png;base64,AA==" },
        error: null,
      }),
    }),
  );
  expect(screen.getByLabelText("统一身份认证密码")).toBeInTheDocument();
  expect(kinds).toContain("authCancel");
  expect(kinds).not.toContain("authPoll");
});

it("does not send an SMS code automatically", () => {
  const kinds = mount("treehole");
  expect(screen.getByRole("button", { name: "发送验证码" })).toBeEnabled();
  expect(kinds).not.toContain("smsSend");
  expect(kinds).not.toContain("authBegin");
});
