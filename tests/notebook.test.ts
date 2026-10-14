import { describe, expect, it } from "vitest";
import {
  itemsOf,
  mergeImport,
  notesOf,
  parseNotebook,
  serializeNotebook,
  setNotes,
  setItems,
} from "../src/lib/notebook";

describe("course notebook file", () => {
  it("starts empty and writes readable Markdown sections", () => {
    const doc = setNotes(
      parseNotebook("", "人工智能中的编程"),
      "作业 40%\n期末 60%",
    );
    const text = serializeNotebook(doc);
    expect(text).toContain("# 人工智能中的编程");
    expect(text).toContain("## 笔记\n\n作业 40%\n期末 60%\n");
    expect(text).toContain("## 任务");
    expect(text).toContain("## 课次");
  });

  it("keeps hand-written and AI-written content it does not manage", () => {
    const source = `# 计算机视觉

> 助教邮箱见群公告

## 笔记

给分：作业 50%

## 任务

- [x] HW1
- [ ] HW2（截止 10/10 23:59）
  - 记得交报告
* 读论文
另外一行说明

## 参考书

- Szeliski
`;
    const doc = parseNotebook(source, "x");
    expect(doc.title).toBe("计算机视觉");
    expect(notesOf(doc)).toBe("给分：作业 50%");
    expect(itemsOf(doc, "tasks").map((i) => [i.done, i.text])).toEqual([
      [true, "HW1"],
      [false, "HW2（截止 10/10 23:59）"],
      [false, "读论文"],
    ]);
    const out = serializeNotebook(doc);
    expect(out).toContain("> 助教邮箱见群公告");
    expect(out).toContain("  - 记得交报告");
    expect(out).toContain("另外一行说明");
    expect(out).toContain("## 参考书\n\n- Szeliski");
    // Round trip is stable.
    expect(serializeNotebook(parseNotebook(out, "x"))).toBe(out);
  });

  it("imports each source once and never restores deleted items", () => {
    let doc = parseNotebook("", "课");
    const rows = [
      { key: "作业/1", text: "HW1" },
      { key: "作业/2", text: "HW2" },
    ];
    doc = mergeImport(doc, "tasks", rows).doc;
    expect(itemsOf(doc, "tasks")).toHaveLength(2);
    // The user deletes HW1 and renames HW2, then imports again.
    const text = serializeNotebook(doc)
      .replace("- [ ] HW1\n", "")
      .replace("HW2", "HW2 小组作业");
    const again = mergeImport(parseNotebook(text, "课"), "tasks", [
      ...rows,
      { key: "作业/3", text: "HW3" },
    ]);
    expect(again.added).toBe(1);
    expect(itemsOf(again.doc, "tasks").map((i) => i.text)).toEqual([
      "HW2 小组作业",
      "HW3",
    ]);
  });
});

it("does not treat headings inside code fences or repeated sections as the editor field", () => {
  const body = "```md\n## 任务\n- [ ] 示例\n```\n\n\n保留空行";
  const source = `# 课\n\n## 笔记\n\n${body}\n\n## 笔记\n\n另一个人的补充\n`;
  const doc = parseNotebook(source, "课");
  expect(notesOf(doc)).toBe(body);
  const output = serializeNotebook(setNotes(doc, "修改后的正文"));
  expect(output).toContain("另一个人的补充");
  expect(output.match(/修改后的正文/g)).toHaveLength(1);
  expect(serializeNotebook(doc)).toContain(body);
});

it("deduplicates duplicate sources within one import", () => {
  const result = mergeImport(parseNotebook("", "课"), "tasks", [
    { key: "1", text: "HW1" },
    { key: "1", text: "HW1" },
  ]);
  expect(result.added).toBe(1);
  expect(itemsOf(result.doc, "tasks")).toHaveLength(1);
});

it("preserves checkbox examples inside fenced code in the task section", () => {
  const example = "```md\n- [ ] 示例不是任务\n```";
  const doc = parseNotebook(
    `# 课\n## 任务\n${example}\n- [ ] 真正任务\n`,
    "课",
  );
  expect(itemsOf(doc, "tasks").map((item) => item.text)).toEqual(["真正任务"]);
  expect(serializeNotebook(doc)).toContain(example);
});
