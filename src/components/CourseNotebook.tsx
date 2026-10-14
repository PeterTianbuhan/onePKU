import {
  Component,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, FolderOpen, Plus, Trash2 } from "lucide-react";
import {
  action,
  call,
  fmtTime,
  type Assignment,
  type Course,
} from "../lib/api";
import {
  itemsOf,
  mergeImport,
  newItem,
  notesOf,
  parseNotebook,
  sectionNames,
  serializeNotebook,
  setItems,
  setNotes,
  type ImportCandidate,
  type Item,
  type ListKey,
  type NotebookDoc,
} from "../lib/notebook";
import { Button } from "./ui";
import type { Replay } from "./ReplayPlayer";

type Snapshot = {
  path: string;
  exists: boolean;
  text: string;
  hash: string;
  saved?: boolean;
  conflict?: boolean;
  readEpoch?: number;
};
type SaveState = "idle" | "pending" | "saving" | "saved" | "error";

// A notebook failure must never take the rest of the course page down with it.
class NotebookBoundary extends Component<
  { children: ReactNode },
  { error: boolean }
> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <section className="notebook" aria-label="课程笔记">
        <p className="subtle">
          课程笔记暂时无法显示，文件本身不受影响。
          <button
            type="button"
            className="text-button"
            onClick={() => this.setState({ error: false })}
          >
            重新加载
          </button>
        </p>
      </section>
    ) : (
      this.props.children
    );
  }
}

export default function CourseNotebook(props: {
  course: Course;
  lectureLabel: (video: Replay) => string;
}) {
  return (
    <NotebookBoundary>
      <NotebookEditor {...props} />
    </NotebookBoundary>
  );
}

function NotebookEditor({
  course,
  lectureLabel,
}: {
  course: Course;
  lectureLabel: (video: Replay) => string;
}) {
  const ident = {
    course: course.id,
    name: course.name,
    semester: course.semester ?? "",
  };
  const epoch = useRef(0);
  const draftKey = `onepku:notebook-draft:${course.id}`;
  const restored = useRef(false);
  const q = useQuery({
    queryKey: ["courseNotebook", course.id],
    queryFn: async () => {
      const readEpoch = epoch.current;
      const r = await call<Snapshot>({ kind: "courseNotebook", ...ident });
      if (r.error) throw Error(r.error.message);
      const snap = r.data as Snapshot | null;
      if (typeof snap?.text !== "string" || typeof snap.hash !== "string")
        throw Error("课程笔记读取结果无效，请重试");
      return { ...snap, readEpoch };
    },
    retry: 1,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  // Pick up edits made in another editor or by an AI: re-read on focus and
  // every few seconds while the window is visible.
  const { refetch } = q;
  useEffect(() => {
    const check = () => {
      if (document.visibilityState === "visible") void refetch();
    };
    const id = setInterval(check, 5000);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [refetch]);
  const [doc, setDoc] = useState<NotebookDoc>();
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState<Snapshot>();
  const [notice, setNotice] = useState("");
  const base = useRef<string | null>(null);
  const setBase = (hash: string) => {
    base.current = hash;
  };
  const dirty = useRef(false);
  const latest = useRef<NotebookDoc>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const saving = useRef<Promise<void>>(Promise.resolve());

  // Adopt the file whenever it changed on disk and nothing local is unsaved.
  useEffect(() => {
    const snap = q.data;
    if (!snap || dirty.current || conflict) return;
    if (snap.readEpoch !== epoch.current) return;
    if (!restored.current) {
      restored.current = true;
      try {
        const draft = JSON.parse(localStorage.getItem(draftKey) || "null");
        if (
          typeof draft?.text === "string" &&
          typeof draft.base === "string" &&
          draft.text !== snap.text
        ) {
          base.current = draft.base;
          const recovered = parseNotebook(draft.text, course.name);
          dirty.current = true;
          latest.current = recovered;
          setDoc(recovered);
          if (draft.base !== snap.hash) setConflict(snap);
          else {
            setState("pending");
            timer.current = setTimeout(() => void save(), 700);
          }
          setNotice("已恢复上次未保存的草稿");
          return;
        }
      } catch {
        /* A corrupt draft must not hide the course's saved file. */
      }
    }
    if (base.current === snap.hash) return;
    const parsed = parseNotebook(snap.text, course.name);
    setBase(snap.hash);
    latest.current = parsed;
    setDoc(parsed);
  }, [q.data, course.name, conflict]);

  const save = useCallback(
    (force = false) => {
      clearTimeout(timer.current);
      saving.current = saving.current.then(async () => {
        const current = latest.current;
        if (!current || (!dirty.current && !force) || base.current === null)
          return;
        const text = serializeNotebook(current);
        setState("saving");
        epoch.current++;
        try {
          const r = await action<Snapshot>({
            kind: "saveCourseNotebook",
            ...ident,
            text,
            base: base.current,
          });
          if (r.conflict) {
            setConflict(r);
            setState("error");
            return;
          }
          setBase(r.hash);
          if (latest.current === current) {
            dirty.current = false;
            localStorage.removeItem(draftKey);
          } else if (latest.current) {
            localStorage.setItem(
              draftKey,
              JSON.stringify({
                text: serializeNotebook(latest.current),
                base: r.hash,
              }),
            );
          }
          setError("");
          setState(dirty.current ? "pending" : "saved");
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          setState("error");
        } finally {
          epoch.current++;
        }
      });
      return saving.current;
    },
    // ident is derived from course; the course key remounts this component.
    [course.id],
  );

  // Flush on navigation; synchronous local drafts survive a window closing
  // before native asynchronous file writes can complete.
  useEffect(() => {
    const flush = () => {
      if (dirty.current) void save();
    };
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, [save]);

  const update = (next: NotebookDoc) => {
    latest.current = next;
    dirty.current = true;
    setDoc(next);
    try {
      localStorage.setItem(
        draftKey,
        JSON.stringify({ text: serializeNotebook(next), base: base.current }),
      );
    } catch {
      setError("无法保留恢复草稿，请等到文件显示已保存后再关闭窗口");
    }
    setState("pending");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), 700);
  };

  const resolve = (keep: "file" | "mine") => {
    const snap = conflict;
    if (!snap) return;
    setBase(snap.hash);
    setConflict(undefined);
    if (keep === "file") {
      dirty.current = false;
      localStorage.removeItem(draftKey);
      const parsed = parseNotebook(snap.text, course.name);
      latest.current = parsed;
      setDoc(parsed);
      setState("idle");
    } else void save(true);
  };

  const importFrom = async (list: ListKey) => {
    if (!latest.current) return;
    setNotice("正在从教学网读取…");
    try {
      let candidates: ImportCandidate[];
      if (list === "tasks") {
        const rows = await action<Assignment[]>({
          kind: "courseAssignments",
          course: course.id,
        });
        candidates = rows.map((a) => ({
          key: `作业/${a.content_id || a.hash_id}`,
          text: a.deadline
            ? `${a.title}（截止 ${fmtTime(a.deadline)}）`
            : a.title,
          done: !!a.last_attempt,
        }));
      } else {
        const rows = await action<Replay[]>({
          kind: "videos",
          course: course.id,
        });
        candidates = [...rows]
          .sort((a, b) => (a.time || a.title).localeCompare(b.time || b.title))
          .map((v) => ({ key: `回放/${v.hash_id}`, text: lectureLabel(v) }));
      }
      const { doc: next, added } = mergeImport(
        latest.current,
        list,
        candidates,
      );
      if (added) update(next);
      setNotice(
        added
          ? `已从教学网导入 ${added} 项，之后可以随意修改`
          : candidates.length
            ? "教学网上没有新的条目，已导入过的不会重复添加"
            : "教学网上暂时没有可导入的条目",
      );
    } catch (e) {
      setNotice(`导入失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  if (!doc)
    return (
      <section className="notebook" aria-label="课程笔记">
        <p className="subtle">
          {q.isError
            ? `课程笔记读取失败：${q.error.message}`
            : "正在读取课程笔记…"}
        </p>
        {q.isError && <Button onClick={() => void q.refetch()}>重试</Button>}
      </section>
    );

  return (
    <section className="notebook" aria-label="课程笔记">
      <header className="notebook-heading">
        <h2>课程笔记</h2>
        <span className={`notebook-state ${state}`} role="status">
          {state === "pending" || state === "saving"
            ? "保存中…"
            : state === "saved"
              ? "已保存"
              : state === "error"
                ? conflict
                  ? "文件已在别处修改"
                  : "保存失败"
                : q.data?.exists
                  ? ""
                  : "还没有笔记，写下第一行即创建文件"}
        </span>
        <Button
          variant="quiet"
          title={q.data?.path}
          onClick={() =>
            void action({ kind: "revealCourseNotebook", ...ident })
          }
        >
          <FolderOpen size={16} />
          在访达中显示
        </Button>
      </header>
      {conflict && (
        <div className="notebook-alert" role="alert">
          <span>
            课程笔记.md 在别的编辑器或 AI 里被修改了，你这里还有没保存的改动。
          </span>
          <Button onClick={() => resolve("file")}>使用文件里的版本</Button>
          <Button variant="quiet" onClick={() => resolve("mine")}>
            用我这里的版本覆盖
          </Button>
        </div>
      )}
      {error && !conflict && (
        <div className="notebook-alert" role="alert">
          <span>{error}</span>
          <Button onClick={() => void save(true)}>重试保存</Button>
        </div>
      )}
      <textarea
        className="notebook-notes"
        aria-label="课程笔记"
        placeholder="课程要求、给分细则、老师说过的重点……随便写，自动保存。"
        value={notesOf(doc)}
        onChange={(e) => update(setNotes(doc, e.target.value))}
        rows={Math.min(24, Math.max(5, notesOf(doc).split("\n").length + 1))}
      />
      <div className="notebook-lists">
        <Checklist
          title={sectionNames.tasks}
          items={itemsOf(doc, "tasks")}
          onChange={(items) => update(setItems(doc, "tasks", items))}
          onImport={() => void importFrom("tasks")}
          placeholder="添加任务"
        />
        <Checklist
          title={sectionNames.lectures}
          items={itemsOf(doc, "lectures")}
          onChange={(items) => update(setItems(doc, "lectures", items))}
          onImport={() => void importFrom("lectures")}
          placeholder="添加课次"
        />
      </div>
      {notice && (
        <p className="subtle notebook-notice" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}

function Checklist({
  title,
  items,
  onChange,
  onImport,
  placeholder,
}: {
  title: string;
  items: Item[];
  onChange: (items: Item[]) => void;
  onImport: () => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    if (!draft.trim()) return;
    onChange([...items, newItem(draft.trim())]);
    setDraft("");
  };
  const patch = (id: string, change: Partial<Item>) =>
    onChange(items.map((i) => (i.id === id ? { ...i, ...change } : i)));
  const left = items.filter((i) => !i.done).length;
  return (
    <section className="checklist" aria-label={title}>
      <header>
        <h3>{title}</h3>
        <span className="subtle">
          {items.length ? `${left} / ${items.length} 未完成` : "空"}
        </span>
        <Button variant="quiet" onClick={onImport}>
          <Download size={15} />
          从教学网导入
        </Button>
      </header>
      <ul>
        {items.map((item) => (
          <li key={item.id} className={item.done ? "done" : ""}>
            <input
              type="checkbox"
              checked={item.done}
              aria-label={`完成：${item.text}`}
              onChange={(e) => patch(item.id, { done: e.target.checked })}
            />
            <input
              className="checklist-text"
              value={item.text}
              aria-label={`${title}内容`}
              onChange={(e) => patch(item.id, { text: e.target.value })}
            />
            <button
              type="button"
              className="checklist-remove"
              aria-label={`删除：${item.text}`}
              onClick={() => onChange(items.filter((i) => i.id !== item.id))}
            >
              <Trash2 size={14} />
            </button>
          </li>
        ))}
      </ul>
      <form
        className="checklist-add"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          value={draft}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button
          type="submit"
          variant="quiet"
          aria-label={placeholder}
          disabled={!draft.trim()}
        >
          <Plus size={15} />
        </Button>
      </form>
    </section>
  );
}
