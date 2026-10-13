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
import Downloads from "../src/components/Downloads";
import { action } from "../src/lib/api";

vi.mock("../src/lib/api", () => ({ action: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("retries a failed download from its record and preserves the visible segment count", async () => {
  let retried = false;
  vi.mocked(action).mockImplementation(async (request: any) => {
    if (request.kind === "downloadRetry") {
      retried = true;
      return { id: "new-job" };
    }
    return [
      {
        id: "failed-job",
        name: "ICS",
        state: "failed",
        completed: 219,
        segments: 719,
        message: "视频片段下载超时",
      },
      ...(retried ? [{ id: "new-job", name: "ICS", state: "queued" }] : []),
    ];
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Downloads />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByTitle("下载记录"));
  expect(await screen.findByText(/219 \/ 719/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "重试下载 ICS" }));
  await waitFor(() =>
    expect(action).toHaveBeenCalledWith({
      kind: "downloadRetry",
      id: "failed-job",
    }),
  );
  expect(await screen.findByText("等待下载")).toBeInTheDocument();
  client.clear();
});

it("shows authentication failures from retry without discarding the failed record", async () => {
  vi.mocked(action).mockImplementation(async (request: any) => {
    if (request.kind === "downloadRetry")
      throw new Error("登录已失效，请重新登录");
    return [{ id: "job", name: "ICS", state: "failed", message: "下载未完成" }];
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Downloads />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByTitle("下载记录"));
  fireEvent.click(await screen.findByRole("button", { name: "重试下载 ICS" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("登录已失效");
  expect(screen.getByText("下载未完成")).toBeInTheDocument();
  client.clear();
});
