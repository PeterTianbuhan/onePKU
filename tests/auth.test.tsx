import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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

it("fetches the login QR code as soon as the dialog opens", async () => {
  const kinds = mount();
  expect(await screen.findByAltText("教学网登录二维码")).toHaveAttribute(
    "src",
    "data:image/png;base64,AA==",
  );
  expect(kinds).toContain("authBegin");
  expect(
    screen.queryByRole("button", { name: "获取登录二维码" }),
  ).not.toBeInTheDocument();
});

it("does not send an SMS code automatically", () => {
  const kinds = mount("treehole");
  expect(screen.getByRole("button", { name: "发送验证码" })).toBeEnabled();
  expect(kinds).not.toContain("smsSend");
  expect(kinds).not.toContain("authBegin");
});
