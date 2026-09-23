import React from "react";
import { afterEach, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  act,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import LocalMaterials from "../src/components/LocalMaterials";
vi.mock("../src/components/MaterialPreview", () => ({
  default: () => <div>附件预览内容</div>,
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function mount(title: string) {
  let downloaded = false;
  let finish!: () => void;
  const ready = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const file = {
    id: "local-file",
    name: "讲义.pdf",
    downloadId: "source",
    bytes: 100,
    modified: 1,
    source: "教学网下载",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => {
      const r = JSON.parse(options.body);
      if (r.kind === "downloadStatus") {
        await ready;
        downloaded = true;
      }
      const data =
        r.kind === "localMaterials"
          ? downloaded
            ? [file]
            : []
          : r.kind === "content"
            ? [
                {
                  id: "item",
                  title,
                  item_type: "Item",
                  description: "",
                  attachments: [{ name: "讲义.pdf", downloadId: "source" }],
                },
              ]
            : r.kind === "download"
              ? { id: "job" }
              : r.kind === "downloadStatus"
                ? { state: "done" }
                : {};
      return {
        ok: true,
        json: async () => ({
          data,
          error: null,
          warnings: [],
          generation: "account",
          stale: false,
          updatedAt: null,
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
      <LocalMaterials course="_1_1" search="" login={() => {}} />
    </QueryClientProvider>,
  );
  return finish;
}
it("simple single-file course materials expose the promised preview", async () => {
  mount("讲义.pdf");
  await screen.findByText("讲义.pdf");
  expect(
    screen.queryByRole("button", { name: "讲义.pdf", exact: true }),
  ).toBeInTheDocument();
});
it("downloading a course attachment leaves its preview open after list refresh", async () => {
  const finish = mount("第一讲");
  fireEvent.click(
    await screen.findByRole("button", { name: "讲义.pdf", exact: true }),
  );
  await screen.findByRole("dialog");
  await screen.findByText("正在下载附件，完成后自动预览…");
  await act(async () => finish());
  await waitFor(() =>
    expect(document.querySelector(".local-material-row")).not.toBeNull(),
  );
  expect(screen.queryByRole("dialog")).toBeInTheDocument();
  expect(screen.queryByText("附件预览内容")).toBeInTheDocument();
});
