// 课程笔记文件格式：课程归档文件夹里的一份普通 Markdown（课程笔记.md）。
// 「## 笔记」是自由文本，「## 任务」「## 课次」是 `- [ ]` 清单；其他内容原样保留，
// 方便在任何编辑器里或让 AI 直接改。导入过的教学网条目记在文件头，删掉的不会再被导入。
export type ListKey = "tasks" | "lectures";
export type Item = { id: string; done: boolean; text: string; sub: string[] };
type Block =
  | { kind: "raw"; lines: string[] }
  | { kind: "notes"; heading: string; body: string }
  | {
      kind: "list";
      key: ListKey;
      heading: string;
      items: Item[];
      extra: string[];
    };
export type NotebookDoc = {
  title: string;
  imported: string[];
  front: string[];
  blocks: Block[];
};

export const sectionNames: Record<"notes" | ListKey, string> = {
  notes: "笔记",
  tasks: "任务",
  lectures: "课次",
};
const aliases: Record<string, "notes" | ListKey> = {
  笔记: "notes",
  课程笔记: "notes",
  备注: "notes",
  任务: "tasks",
  任务列表: "tasks",
  作业: "tasks",
  课次: "lectures",
  课程列表: "lectures",
  课程安排: "lectures",
};
const IMPORTED = "教学网已导入";

let counter = 0;
const nextId = () => `i${++counter}`;
export function newItem(text: string, done = false): Item {
  return { id: nextId(), done, text, sub: [] };
}

function splitFront(text: string) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return { front: [] as string[], lines };
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (end < 0) return { front: [] as string[], lines };
  return { front: lines.slice(1, end), lines: lines.slice(end + 1) };
}

function trimBlank(lines: string[]) {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
}

export function parseNotebook(
  text: string,
  fallbackTitle: string,
): NotebookDoc {
  const { front: rawFront, lines } = splitFront(text);
  let imported: string[] = [];
  const front: string[] = [];
  for (const line of rawFront) {
    const m = line.match(/^\s*([^:：]+)[:：]\s*(.*)$/);
    if (m && m[1].trim() === IMPORTED) {
      imported = m[2]
        .split(/[,，\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (!/^\s*onepku\s*[:：]/i.test(line)) front.push(line);
  }
  let title = fallbackTitle;
  const blocks: Block[] = [];
  let current: { heading: string; lines: string[] } | null = null;
  const preamble: string[] = [];
  const sections: { heading: string; lines: string[] }[] = [];
  let titled = false;
  let fence: { marker: string; length: number } | undefined;
  for (const line of lines) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence || marker) {
      if (fence) {
        if (
          marker &&
          marker[1][0] === fence.marker &&
          marker[1].length >= fence.length &&
          !marker[2].trim()
        )
          fence = undefined;
      } else if (marker)
        fence = { marker: marker[1][0], length: marker[1].length };
      if (current) current.lines.push(line);
      else preamble.push(line);
      continue;
    }
    const h1 = line.match(/^#\s+(.+?)\s*$/);
    if (!titled && !current && h1) {
      title = h1[1];
      titled = true;
      continue;
    }
    const h2 = line.match(/^##\s+(.+?)\s*#*\s*$/);
    if (h2) {
      current = { heading: h2[1], lines: [] };
      sections.push(current);
    } else if (current) current.lines.push(line);
    else preamble.push(line);
  }
  const intro = trimBlank(preamble);
  if (intro.length) blocks.push({ kind: "raw", lines: intro });
  const managed = new Set<string>();
  for (const section of sections) {
    const candidate = aliases[section.heading.trim()];
    const kind = candidate && !managed.has(candidate) ? candidate : undefined;
    if (kind) managed.add(kind);
    if (kind === "notes") {
      blocks.push({
        kind: "notes",
        heading: section.heading,
        body: trimBlank(section.lines).join("\n"),
      });
    } else if (kind) {
      const items: Item[] = [];
      const extra: string[] = [];
      let listFence: { marker: string; length: number } | undefined;
      for (const line of trimBlank(section.lines)) {
        const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
        if (listFence || marker) {
          if (listFence) {
            if (
              marker &&
              marker[1][0] === listFence.marker &&
              marker[1].length >= listFence.length &&
              !marker[2].trim()
            )
              listFence = undefined;
          } else if (marker)
            listFence = { marker: marker[1][0], length: marker[1].length };
          if (items.length) items[items.length - 1].sub.push(line);
          else extra.push(line);
          continue;
        }
        const checkbox = line.match(/^[-*+]\s+\[([ xX])\]\s?(.*)$/);
        const bullet = line.match(/^[-*+]\s+(.*)$/);
        if (checkbox) items.push(newItem(checkbox[2], checkbox[1] !== " "));
        else if (bullet) items.push(newItem(bullet[1]));
        else if (items.length) items[items.length - 1].sub.push(line);
        else extra.push(line);
      }
      blocks.push({
        kind: "list",
        key: kind,
        heading: section.heading,
        items,
        extra,
      });
    } else {
      blocks.push({
        kind: "raw",
        lines: [`## ${section.heading}`, "", ...trimBlank(section.lines)],
      });
    }
  }
  return { title, imported, front, blocks };
}

export function serializeNotebook(doc: NotebookDoc): string {
  const out: string[] = ["---", "onepku: 课程笔记"];
  out.push(...doc.front);
  if (doc.imported.length) out.push(`${IMPORTED}: ${doc.imported.join(", ")}`);
  out.push("---", "", `# ${doc.title}`, "");
  for (const block of withSections(doc).blocks) {
    if (block.kind === "raw") out.push(...block.lines, "");
    else if (block.kind === "notes") {
      out.push(`## ${block.heading}`, "");
      if (block.body.trim()) out.push(block.body.replace(/\s+$/, ""), "");
    } else {
      out.push(`## ${block.heading}`, "");
      if (block.extra.length) out.push(...block.extra);
      for (const item of block.items) {
        out.push(
          `- [${item.done ? "x" : " "}] ${item.text.replace(/\n/g, " ")}`,
        );
        out.push(...item.sub);
      }
      if (block.items.length) out.push("");
    }
  }
  return out.join("\n").replace(/\n*$/, "\n");
}

/** Ensures the notes, tasks and lectures sections exist, in that order. */
export function withSections(doc: NotebookDoc): NotebookDoc {
  const blocks = [...doc.blocks];
  const has = (k: "notes" | ListKey) =>
    blocks.some((b) =>
      k === "notes" ? b.kind === "notes" : b.kind === "list" && b.key === k,
    );
  let at = blocks.findIndex((b) => b.kind !== "raw");
  if (at < 0) at = blocks.length;
  if (!has("notes"))
    blocks.splice(at++, 0, {
      kind: "notes",
      heading: sectionNames.notes,
      body: "",
    });
  else at = blocks.findIndex((b) => b.kind === "notes") + 1;
  for (const key of ["tasks", "lectures"] as const) {
    if (!has(key)) {
      blocks.splice(at++, 0, {
        kind: "list",
        key,
        heading: sectionNames[key],
        items: [],
        extra: [],
      });
    } else at = blocks.findIndex((b) => b.kind === "list" && b.key === key) + 1;
  }
  return { ...doc, blocks };
}

export function notesOf(doc: NotebookDoc) {
  const b = doc.blocks.find((b) => b.kind === "notes");
  return b?.kind === "notes" ? b.body : "";
}
export function setNotes(doc: NotebookDoc, body: string): NotebookDoc {
  const d = withSections(doc);
  return {
    ...d,
    blocks: d.blocks.map((b) => (b.kind === "notes" ? { ...b, body } : b)),
  };
}
export function itemsOf(doc: NotebookDoc, key: ListKey): Item[] {
  const b = doc.blocks.find((b) => b.kind === "list" && b.key === key);
  return b?.kind === "list" ? b.items : [];
}
export function setItems(
  doc: NotebookDoc,
  key: ListKey,
  items: Item[],
): NotebookDoc {
  const d = withSections(doc);
  return {
    ...d,
    blocks: d.blocks.map((b) =>
      b.kind === "list" && b.key === key ? { ...b, items } : b,
    ),
  };
}

export type ImportCandidate = { key: string; text: string; done?: boolean };
/** Appends only sources never imported before; edits and deletions stay. */
export function mergeImport(
  doc: NotebookDoc,
  list: ListKey,
  candidates: ImportCandidate[],
): { doc: NotebookDoc; added: number } {
  const seen = new Set(doc.imported);
  const fresh = candidates.filter((c) => {
    if (seen.has(c.key)) return false;
    seen.add(c.key);
    return true;
  });
  if (!fresh.length) return { doc, added: 0 };
  const items = [
    ...itemsOf(doc, list),
    ...fresh.map((c) => newItem(c.text, !!c.done)),
  ];
  const next = setItems(doc, list, items);
  return {
    doc: { ...next, imported: [...doc.imported, ...fresh.map((c) => c.key)] },
    added: fresh.length,
  };
}
