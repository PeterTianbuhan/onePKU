import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Auth from "../src/components/Auth";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(scope?: "treehole") {
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
      <Auth service="course" scope={scope} onClose={() => {}} />
    </QueryClientProvider>,
  );
  return kinds;
}

it("opens on the password form and keeps the QR code one step away", async () => {
  const kinds = mount();
  expect(await screen.findByLabelText("校园账号")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "登录" })).toBeInTheDocument();
  expect(kinds).not.toContain("authBegin");
  fireEvent.click(
    screen.getByRole("button", { name: "改用北京大学 App 扫码" }),
  );
  expect(await screen.findByAltText("教学网登录二维码")).toHaveAttribute(
    "src",
    "data:image/png;base64,AA==",
  );
  expect(kinds).toContain("authBegin");
});

it("does not send an SMS code automatically", () => {
  const kinds = mount("treehole");
  expect(screen.getByRole("button", { name: "发送验证码" })).toBeEnabled();
  expect(kinds).not.toContain("smsSend");
  expect(kinds).not.toContain("authBegin");
});

it("shows partial login and keychain failures on the success screen", async () => {
  mount();
  await screen.findByLabelText("校园账号");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => ({
      ok: true,
      json: async () => ({
        data:
          JSON.parse(options.body).kind === "authPassword"
            ? {
                state: "success",
                done: ["course"],
                failed: [{ service: "portal", message: "门户连接失败" }],
                remembered: false,
              }
            : {},
        error: null,
        warnings: [],
        stale: false,
        generation: "single",
      }),
    })),
  );
  fireEvent.change(screen.getByLabelText("校园账号"), {
    target: { value: "test-user" },
  });
  fireEvent.change(screen.getByLabelText("密码"), {
    target: { value: "test-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "登录" }));
  await screen.findByText("已连接");
  expect(screen.getByRole("status")).toHaveTextContent("门户连接失败");
  expect(screen.getByRole("status")).toHaveTextContent("钥匙串未能完整保存");
});
