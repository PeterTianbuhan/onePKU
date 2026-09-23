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
import { AttachmentRow } from "../src/components/ui";
vi.mock("../src/components/MaterialPreview", () => ({
  default: ({ id }: { id: string }) => <div>预览文件 {id}</div>,
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function mount(
  options: {
    downloaded?: boolean;
    failed?: boolean;
    changed?: boolean;
    name?: string;
    legacyIdentity?: boolean;
  } = {},
) {
  let downloaded = !!options.downloaded;
  const requests: Record<string, string>[] = [];
  const file = {
    id: "correct-file",
    name: options.name ?? "homework.pdf",
    downloadId: options.legacyIdentity ? "current-source-id" : "source-id",
    downloadIds: options.legacyIdentity
      ? ["current-source-id", "source-id"]
      : [],
    bytes: 200,
    modified: 5,
    source: "教学网下载",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      if (request.kind === "downloadStatus" && !options.failed)
        downloaded = true;
      const data =
        request.kind === "localMaterials"
          ? [
              {
                ...file,
                id: "same-name-wrong-source",
                downloadId: "different-source",
                downloadIds: [],
              },
              ...(downloaded ? [file] : []),
            ]
          : request.kind === "download"
            ? { id: "job-id" }
            : request.kind === "downloadStatus"
              ? {
                  state: options.failed ? "failed" : "done",
                  message: options.failed ? "下载失败，请重试" : undefined,
                }
              : {};
      return {
        ok: true,
        json: async () => ({
          data,
          error: null,
          warnings: [],
          stale: false,
          updatedAt: null,
          generation:
            options.changed && request.kind === "downloadStatus"
              ? "new-account"
              : "account",
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
      <AttachmentRow
        course="_1_1"
        file={{ name: file.name, downloadId: "source-id" }}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: file.name }));
  return requests;
}
it("clicks an attachment name, downloads the correct source, and opens its preview", async () => {
  const requests = mount();
  await screen.findByText("预览文件 correct-file");
  expect(requests.filter((r) => r.kind === "download")).toEqual([
    { kind: "download", id: "source-id" },
  ]);
  expect(screen.getByRole("dialog")).toHaveAccessibleName("homework.pdf");
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});
it("reuses an existing copy without another download", async () => {
  const requests = mount({ downloaded: true });
  await screen.findByText("预览文件 correct-file");
  expect(requests.some((r) => r.kind === "download")).toBe(false);
});
it("opens a legacy semester copy through its old attachment identity without downloading again", async () => {
  const requests = mount({ downloaded: true, legacyIdentity: true });
  await screen.findByText("预览文件 correct-file");
  expect(requests.some((r) => r.kind === "download")).toBe(false);
});
it("offers the default application for unsupported formats", async () => {
  const requests = mount({ downloaded: true, name: "homework.docx" });
  await screen.findByText(/此文件格式或大小/);
  fireEvent.click(screen.getByRole("button", { name: "用默认应用打开" }));
  await waitFor(() =>
    expect(requests).toContainEqual({
      kind: "openLocalMaterial",
      course: "_1_1",
      id: "correct-file",
    }),
  );
  expect(screen.queryByText("预览文件 correct-file")).not.toBeInTheDocument();
});
it("shows download failure with a retry instead of a blank preview", async () => {
  mount({ failed: true });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "下载失败，请重试",
  );
  expect(screen.getByRole("button", { name: "重试预览" })).toBeEnabled();
});
it("does not preview files after the account changes during download", async () => {
  mount({ changed: true });
  expect(await screen.findByRole("alert")).toHaveTextContent("账号已变化");
  expect(screen.queryByText("预览文件 correct-file")).not.toBeInTheDocument();
});
