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
import CourseNotebook from "../src/components/CourseNotebook";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function mount(initial = "# 课\n\n## 笔记\n\n原文\n", initialHash = "first") {
  let text = initial,
    hash = initialHash;
  let saves = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => {
      const req = JSON.parse(options.body);
      let data: unknown = {
        text,
        hash,
        path: "/course/课程笔记.md",
        exists: true,
      };
      if (req.kind === "saveCourseNotebook") {
        saves++;
        if (req.base !== hash) data = { ...(data as object), conflict: true };
        else {
          text = req.text;
          hash = `save-${saves}`;
          data = { text, hash, saved: true };
        }
      }
      return {
        ok: true,
        json: async () => ({
          data,
          error: null,
          warnings: [],
          stale: false,
          generation: "single",
        }),
      };
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <CourseNotebook
        course={{ id: "_1_1", name: "课" }}
        lectureLabel={(v) => v.title}
      />
    </QueryClientProvider>,
  );
  return {
    client,
    text: () => text,
    saves: () => saves,
    external: (value: string, version: string) => {
      text = value;
      hash = version;
    },
    poll: () =>
      client.invalidateQueries({ queryKey: ["courseNotebook", "_1_1"] }),
  };
}

it("accepts an external undo back to an earlier file version", async () => {
  const initial = "# 课\n\n## 笔记\n\n原文\n";
  const app = mount(initial);
  const editor = await screen.findByRole("textbox", { name: "课程笔记" });
  fireEvent.change(editor, { target: { value: "新版本" } });
  await screen.findByText("已保存");
  app.external(initial, "first");
  await app.poll();
  await waitFor(() => expect(editor).toHaveValue("原文"));
});

it("restores a draft after closing before autosave and then writes the file", async () => {
  localStorage.setItem(
    "onepku:notebook-draft:_1_1",
    JSON.stringify({ text: "# 课\n\n## 笔记\n\n未保存草稿\n", base: "first" }),
  );
  const app = mount();
  expect(await screen.findByRole("textbox", { name: "课程笔记" })).toHaveValue(
    "未保存草稿",
  );
  await screen.findByText("已保存");
  expect(app.text()).toContain("未保存草稿");
  expect(localStorage.getItem("onepku:notebook-draft:_1_1")).toBeNull();
});

it("keeps a recovered draft from overwriting a newer external file", async () => {
  localStorage.setItem(
    "onepku:notebook-draft:_1_1",
    JSON.stringify({ text: "# 课\n\n## 笔记\n\n草稿\n", base: "previous" }),
  );
  const app = mount();
  await screen.findByRole("button", { name: "使用文件里的版本" });
  expect(app.saves()).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "使用文件里的版本" }));
  expect(screen.getByRole("textbox", { name: "课程笔记" })).toHaveValue("原文");
  expect(localStorage.getItem("onepku:notebook-draft:_1_1")).toBeNull();
});
