import React from "react";
import { afterEach, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import LocalMaterials from "../src/components/LocalMaterials";
import { chooseCourseFiles } from "../src/lib/api";
vi.mock("../src/lib/api", async (original) => ({
  ...(await original<typeof import("../src/lib/api")>()),
  chooseCourseFiles: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
function mount() {
  let files = [
    {
      id: "file-id",
      name: "讲义.txt",
      bytes: 10,
      modified: 1,
      source: "本地添加",
    },
  ];
  let failTrash = true;
  const requests: Record<string, string>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => {
      const r = JSON.parse(options.body);
      requests.push(r);
      const failed = r.kind === "trashLocalMaterial" && failTrash;
      if (r.kind === "trashLocalMaterial") {
        if (!failTrash) files = [];
        failTrash = false;
      }
      return {
        ok: true,
        json: async () => ({
          data: failed
            ? null
            : r.kind === "localMaterials"
              ? files
              : r.kind === "content"
                ? []
                : {},
          error: failed
            ? { code: "unavailable", message: "文件正忙，请重试" }
            : null,
          warnings: [],
          generation: "test",
          updatedAt: null,
          stale: false,
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
      <LocalMaterials course="course-id" search="" login={() => {}} />
    </QueryClientProvider>,
  );
  return requests;
}
it("requires confirmation, keeps a failed deletion retryable, and refreshes after success", async () => {
  const requests = mount();
  fireEvent.click(await screen.findByLabelText("讲义.txt 的更多操作"));
  fireEvent.click(screen.getByRole("button", { name: "删除 讲义.txt" }));
  expect(requests.filter((r) => r.kind === "trashLocalMaterial")).toHaveLength(
    0,
  );
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(requests.filter((r) => r.kind === "trashLocalMaterial")).toHaveLength(
    0,
  );
  fireEvent.click(screen.getByLabelText("讲义.txt 的更多操作"));
  fireEvent.click(screen.getByRole("button", { name: "删除 讲义.txt" }));
  fireEvent.click(
    screen.getByRole("button", { name: /^移到(废纸篓|回收站)$/ }),
  );
  await screen.findByRole("alert");
  expect(screen.getByText("讲义.txt")).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: /^移到(废纸篓|回收站)$/ }),
  );
  await screen.findByText("还没有本机资料");
  expect(requests.filter((r) => r.kind === "trashLocalMaterial")).toEqual([
    { kind: "trashLocalMaterial", course: "course-id", id: "file-id" },
    { kind: "trashLocalMaterial", course: "course-id", id: "file-id" },
  ]);
});
it("handles picker cancellation and partial import without hiding failed files", async () => {
  mount();
  await screen.findByText("讲义.txt");
  vi.mocked(chooseCourseFiles)
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({
      added: [
        { name: "a.txt", bytes: 2 },
        { name: "b.txt", bytes: 2 },
      ],
      reused: 1,
      failed: [{ name: "locked.txt", message: "无法读取" }],
    });
  fireEvent.click(screen.getByRole("button", { name: "添加资料" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "添加资料" })).toBeEnabled(),
  );
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "添加资料" }));
  await screen.findByText("已添加 1 份资料 · 1 份资料已存在");
  expect(screen.getByRole("alert")).toHaveTextContent("locked.txt：无法读取");
  expect(chooseCourseFiles).toHaveBeenLastCalledWith("course-id");
});

it("merges only the matching download copy and restores download after removing that copy", async () => {
  let files = [
    {
      id: "downloaded",
      name: "讲义.pdf",
      bytes: 12,
      modified: 1,
      source: "教学网下载",
      downloadId: "registered",
    },
    {
      id: "personal",
      name: "讲义.pdf",
      bytes: 20,
      modified: 1,
      source: "本地添加",
      downloadId: null,
    },
  ];
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => {
      const r = JSON.parse(options.body);
      requests.push(r);
      if (r.kind === "trashLocalMaterial")
        files = files.filter((f) => f.id !== r.id);
      return {
        ok: true,
        json: async () => ({
          data:
            r.kind === "localMaterials"
              ? files
              : r.kind === "content"
                ? [
                    {
                      id: "item",
                      title: "第一讲",
                      item_type: "Item",
                      description: "",
                      attachments: [
                        { name: "讲义.pdf", downloadId: "registered" },
                      ],
                    },
                  ]
                : {},
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
      <LocalMaterials course="course-id" search="" login={() => {}} />
    </QueryClientProvider>,
  );
  await screen.findByText(/已下载 · 本地副本/);
  const school = within(screen.getByRole("region", { name: "教学网资料" }));
  const personal = within(screen.getByRole("region", { name: "本机资料" }));
  expect(
    personal.getByRole("button", { name: /讲义.pdf.*本地添加/ }),
  ).toBeEnabled();
  expect(
    school.queryByRole("button", { name: "下载", exact: true }),
  ).not.toBeInTheDocument();
  fireEvent.click(school.getByLabelText("讲义.pdf 的更多操作"));
  fireEvent.click(school.getByRole("button", { name: "删除 讲义.pdf" }));
  expect(requests.some((r) => r.kind === "trashLocalMaterial")).toBe(false);
  fireEvent.click(
    school.getByRole("button", { name: /^移到(废纸篓|回收站)$/ }),
  );
  await school.findByRole("button", { name: "下载", exact: true });
  expect(
    personal.getByRole("button", { name: /讲义.pdf.*本地添加/ }),
  ).toBeInTheDocument();
  expect(requests.filter((r) => r.kind === "trashLocalMaterial")).toEqual([
    { kind: "trashLocalMaterial", course: "course-id", id: "downloaded" },
  ]);
});
it("keeps local copies usable when the school materials cannot load", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => {
      const r = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          data:
            r.kind === "content"
              ? null
              : [
                  {
                    id: "copy",
                    name: "离线讲义.pdf",
                    bytes: 12,
                    modified: 1,
                    source: "教学网下载",
                    downloadId: "old-id",
                  },
                ],
          error:
            r.kind === "content"
              ? { code: "network", message: "教学网暂不可用" }
              : null,
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
      <LocalMaterials course="course-id" search="" login={() => {}} />
    </QueryClientProvider>,
  );
  await screen.findByText("教学网暂不可用");
  expect(
    await screen.findByRole("button", { name: /离线讲义.pdf.*教学网下载/ }),
  ).toBeEnabled();
});
