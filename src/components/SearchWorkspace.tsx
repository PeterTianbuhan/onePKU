import { searchShortcut } from "../lib/platform";
import {
  lazy,
  Suspense,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Search,
  Plus,
  X,
  ArrowUpRight,
  FileText,
  Play,
  BookOpen,
  Bell,
  FileCheck2,
  Maximize2,
  Minimize2,
  RefreshCw,
} from "lucide-react";
import { action } from "../lib/api";
import { openBrowser } from "../lib/browser";
import {
  excerpt,
  searchItems,
  searchLabels,
  type SearchItem,
} from "../lib/search";
import { useSearchIndex } from "./useSearchIndex";
import { AttachmentRow } from "./ui";
const MaterialPreview = lazy(() => import("./MaterialPreview"));
const ReplayPlayer = lazy(() => import("./ReplayPlayer"));
type Tab = {
  id: number;
  query: string;
  kind: string;
  course: string;
  selected?: string;
  scroll: number;
  pages: Record<string, number>;
};
const freshTab = (id: number): Tab => ({
  id,
  query: "",
  kind: "",
  course: "",
  scroll: 0,
  pages: {},
});
const icons = {
  course: BookOpen,
  material: FileText,
  replay: Play,
  notice: Bell,
  assignment: FileCheck2,
};
function Highlight({ text, query }: { text: string; query: string }) {
  const terms = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!terms.length) return <>{text}</>;
  const re = new RegExp(`(${terms.join("|")})`, "ig");
  return (
    <>
      {text
        .split(re)
        .map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part))}
    </>
  );
}
export default function SearchWorkspace({
  generation,
}: {
  generation: string;
}) {
  const [open, setOpen] = useState(false);
  const [activated, setActivated] = useState(false);
  const [tabs, setTabs] = useState<Tab[]>([freshTab(1)]);
  const [active, setActive] = useState(1);
  const [allTerms, setAllTerms] = useState(false);
  const [revision, setRevision] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [playing, setPlaying] = useState("");
  const [error, setError] = useState("");
  const sequence = useRef(1);
  const input = useRef<HTMLInputElement>(null);
  const inputAt = useRef<number | null>(null);
  const results = useRef<HTMLDivElement>(null);
  const tab = tabs.find((t) => t.id === active) ?? tabs[0];
  const index = useSearchIndex(activated, generation, allTerms, revision);
  const query = useDeferredValue(tab.query);
  const matches = useMemo(
    () =>
      searchItems(index.items, query, tab.kind, tab.course).filter(
        (i) =>
          (allTerms || i.course.current) && (query.trim() || !i.source.page),
      ),
    [index.items, query, tab.kind, tab.course, allTerms],
  );
  useEffect(() => {
    if (inputAt.current === null || query !== tab.query) return;
    const started = inputAt.current;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        if (inputAt.current !== started) return;
        if (results.current)
          results.current.dataset.searchLatencyMs = (
            performance.now() - started
          ).toFixed(1);
        inputAt.current = null;
      });
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [query, tab.query, matches]);
  const rows = matches.slice(0, 150);
  const selected = rows.find((i) => i.key === tab.selected) ?? rows[0];
  const position = selected ? rows.indexOf(selected) : -1;
  const update = (patch: Partial<Tab>) =>
    setTabs((ts) => ts.map((t) => (t.id === active ? { ...t, ...patch } : t)));
  const openSearch = (value: boolean) => {
    setOpen(value);
    if (value) setActivated(true);
    else {
      setExpanded(false);
      setPlaying("");
    }
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        setActivated(true);
        setExpanded(false);
        setPlaying("");
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    setPlaying("");
    setError("");
  }, [selected?.key]);
  useEffect(() => {
    if (!open) setPlaying("");
  }, [open]);
  const add = () => {
    const id = ++sequence.current;
    setTabs((ts) => [...ts, freshTab(id)]);
    setActive(id);
    setExpanded(false);
    requestAnimationFrame(() => input.current?.focus());
  };
  const switchTab = (id: number) => {
    if (results.current) update({ scroll: results.current.scrollTop });
    setActive(id);
    setExpanded(false);
    requestAnimationFrame(() => {
      input.current?.focus();
      if (results.current)
        results.current.scrollTop = tabs.find((t) => t.id === id)?.scroll ?? 0;
    });
  };
  const closeTab = (id: number) => {
    if (tabs.length === 1) {
      setTabs([freshTab(id)]);
      return;
    }
    const next = tabs.filter((t) => t.id !== id);
    setTabs(next);
    if (active === id)
      setActive(next[Math.max(0, tabs.findIndex((t) => t.id === id) - 1)].id);
  };
  const choose = (item: SearchItem) => {
    update({ selected: item.key });
  };
  const openItem = async (item: SearchItem) => {
    setError("");
    try {
      if (item.local) setExpanded(true);
      else if (item.url) await openBrowser(item.url, item.title);
      else {
        location.hash = encodeURIComponent(item.route);
        openSearch(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法打开，请刷新后重试");
    }
  };
  return (
    <Dialog.Root open={open} onOpenChange={openSearch}>
      <Dialog.Trigger
        className="global-search-trigger"
        title={`搜索（${searchShortcut()}）`}
      >
        <Search size={17} />
        <span>搜索</span>
        <kbd>{searchShortcut()}</kbd>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay search-overlay" />
        <Dialog.Content
          className={`search-workspace ${expanded ? "search-expanded" : ""}`}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            input.current?.focus();
            requestAnimationFrame(() => {
              if (results.current) results.current.scrollTop = tab.scroll;
            });
          }}
          onEscapeKeyDown={(e) => {
            if (expanded) {
              e.preventDefault();
              setExpanded(false);
            }
          }}
        >
          <Dialog.Title className="sr-only">搜索学习内容</Dialog.Title>
          <Dialog.Description className="sr-only">
            搜索课程、资料、回放、作业和通知。上下方向键选择结果，回车打开，支持多个搜索标签。
          </Dialog.Description>
          <div className="search-tab-bar">
            <div role="tablist" aria-label="搜索标签">
              {tabs.map((t) => (
                <div
                  className={`search-tab ${active === t.id ? "active" : ""}`}
                  key={t.id}
                >
                  <button
                    role="tab"
                    aria-selected={active === t.id}
                    onClick={() => switchTab(t.id)}
                    title={t.query || "新搜索"}
                  >
                    <Search size={13} />
                    <span>{t.query || "新搜索"}</span>
                  </button>
                  <button
                    aria-label={`关闭搜索标签 ${t.query || t.id}`}
                    onClick={() => closeTab(t.id)}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
            <button
              className="icon-button"
              aria-label="新建搜索标签"
              onClick={add}
            >
              <Plus size={17} />
            </button>
            <Dialog.Close
              className="icon-button search-close"
              aria-label="关闭搜索"
            >
              <X size={18} />
            </Dialog.Close>
          </div>
          <div className="search-input-row">
            <Search size={24} />
            <input
              ref={input}
              value={tab.query}
              aria-label="搜索学习内容"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={!expanded}
              aria-controls="learning-search-results"
              aria-activedescendant={
                selected ? `search-result-${position}` : undefined
              }
              placeholder="找一份资料、一节回放，或一段内容…"
              onChange={(e) => {
                inputAt.current = performance.now();
                update({
                  query: e.target.value,
                  selected: undefined,
                  scroll: 0,
                });
                setExpanded(false);
                if (results.current) results.current.scrollTop = 0;
              }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const n = Math.max(
                    0,
                    Math.min(
                      rows.length - 1,
                      position + (e.key === "ArrowDown" ? 1 : -1),
                    ),
                  );
                  if (rows[n]) {
                    choose(rows[n]);
                    document
                      .getElementById(`search-result-${n}`)
                      ?.scrollIntoView({ block: "nearest" });
                  }
                }
                if (e.key === "Enter" && selected) {
                  e.preventDefault();
                  void openItem(selected);
                }
              }}
            />
            {tab.query && (
              <button
                className="icon-button"
                aria-label="清空搜索"
                onClick={() => {
                  update({ query: "", selected: undefined });
                  input.current?.focus();
                }}
              >
                <X size={18} />
              </button>
            )}
          </div>
          <div className="search-filters">
            <div className="search-kinds">
              {[["", "全部"], ...Object.entries(searchLabels)].map(
                ([kind, label]) => (
                  <button
                    key={kind}
                    aria-pressed={tab.kind === kind}
                    className={tab.kind === kind ? "active" : ""}
                    onClick={() => update({ kind, selected: undefined })}
                  >
                    {label}
                  </button>
                ),
              )}
            </div>
            <select
              aria-label="搜索课程范围"
              value={tab.course}
              onChange={(e) =>
                update({ course: e.target.value, selected: undefined })
              }
            >
              <option value="">所有课程</option>
              {index.courses
                .filter((c) => allTerms || c.current)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </div>
          <div className="search-body">
            <div
              className="search-results"
              id="learning-search-results"
              role="listbox"
              aria-label="搜索结果"
              ref={results}
              onScroll={(e) => update({ scroll: e.currentTarget.scrollTop })}
            >
              <div className="search-results-heading">
                {query.trim() ? `${matches.length} 个结果` : "浏览学习内容"}
                {matches.length > 150 && " · 显示前 150 项"}
              </div>
              {rows.map((item, i) => {
                const Icon = icons[item.kind];
                return (
                  <button
                    id={`search-result-${i}`}
                    role="option"
                    aria-selected={selected?.key === item.key}
                    key={item.key}
                    className={`search-result ${selected?.key === item.key ? "selected" : ""}`}
                    onClick={() => choose(item)}
                    onDoubleClick={() => void openItem(item)}
                  >
                    <span
                      className={`search-result-icon search-icon-${item.kind}`}
                    >
                      <Icon size={18} />
                    </span>
                    <span className="search-result-copy">
                      <strong>
                        <Highlight text={item.title} query={query} />
                      </strong>
                      <small>
                        {item.course.name}
                        {item.source.page
                          ? ` · 第 ${item.source.page} 页`
                          : ` · ${searchLabels[item.kind]}`}
                      </small>
                      {item.body && (
                        <span className="search-snippet">
                          <Highlight
                            text={excerpt(item.body, query)}
                            query={query}
                          />
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
              {!rows.length && (
                <div className="search-empty">
                  <Search size={30} />
                  <h3>
                    {index.busy ? "正在查找学习内容" : "没有找到匹配内容"}
                  </h3>
                  <p>
                    {index.busy
                      ? "已读取的内容会陆续出现在这里。"
                      : "试试课程名、文件名，或更短的关键词。"}
                  </p>
                  {!allTerms && (
                    <button
                      className="button"
                      onClick={() => setAllTerms(true)}
                    >
                      搜索全部学期
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="search-preview" aria-label="搜索结果预览">
              {selected ? (
                <>
                  <header className="search-preview-header">
                    <span>{searchLabels[selected.kind]}预览</span>
                    <button
                      className="icon-button"
                      aria-label={expanded ? "缩小预览" : "放大预览"}
                      onClick={() => setExpanded((v) => !v)}
                    >
                      {expanded ? (
                        <Minimize2 size={16} />
                      ) : (
                        <Maximize2 size={16} />
                      )}
                    </button>
                  </header>
                  <div className="search-preview-content">
                    <p className="search-preview-course">
                      {selected.course.name} · {selected.course.semester}
                    </p>
                    <h2>{selected.title}</h2>
                    {selected.detail && (
                      <p className="subtle">{selected.detail}</p>
                    )}
                    {selected.local ? (
                      <Suspense
                        fallback={<p className="subtle">正在打开预览…</p>}
                      >
                        <MaterialPreview
                          key={`${active}:${selected.local.id}`}
                          course={selected.course.id}
                          id={selected.local.id}
                          generation={generation}
                          page={tab.pages[selected.key] ?? selected.source.page}
                          onPageChange={(page) =>
                            update({
                              pages: { ...tab.pages, [selected.key]: page },
                            })
                          }
                        />
                      </Suspense>
                    ) : selected.replay ? (
                      <>
                        {playing === selected.key ? (
                          <Suspense fallback={<p>正在打开回放…</p>}>
                            <ReplayPlayer
                              course={selected.course.id}
                              video={selected.replay}
                              generation={generation}
                              autoPlay={false}
                              close={() => setPlaying("")}
                            />
                          </Suspense>
                        ) : (
                          <button
                            className="search-video-preview"
                            onClick={() => {
                              document
                                .querySelectorAll("video")
                                .forEach((v) => v.pause());
                              setPlaying(selected.key);
                            }}
                          >
                            <Play size={32} />
                            <span>预览这节回放</span>
                            <small>{selected.replay.time}</small>
                          </button>
                        )}
                      </>
                    ) : (
                      <p className="search-preview-text">
                        <Highlight
                          text={selected.body || "打开课程查看完整内容。"}
                          query={query}
                        />
                      </p>
                    )}
                    {selected.attachment && (
                      <AttachmentRow
                        file={selected.attachment}
                        course={selected.course.id}
                      />
                    )}
                  </div>
                  <footer className="search-preview-actions">
                    {selected.local && (
                      <button
                        className="button quiet"
                        onClick={() =>
                          void action({
                            kind: "openLocalMaterial",
                            course: selected.course.id,
                            id: selected.local!.id,
                          }).catch((e) => setError(e.message))
                        }
                      >
                        用默认应用打开
                      </button>
                    )}
                    {error && (
                      <span role="alert" className="inline-error">
                        {error}
                      </span>
                    )}
                    <button
                      className="button"
                      onClick={() => void openItem(selected)}
                    >
                      {selected.local
                        ? "展开这一页"
                        : selected.url
                          ? "打开原文"
                          : selected.replay
                            ? "打开回放"
                            : "打开所在页面"}
                      <ArrowUpRight size={15} />
                    </button>
                  </footer>
                </>
              ) : (
                <div className="search-preview-placeholder">
                  <FileText size={36} />
                  <p>在左侧选一项，先看看内容</p>
                </div>
              )}
            </div>
          </div>
          <footer className="search-status">
            <details>
              <summary>
                {index.busy
                  ? `后台更新 ${index.done}/${index.total} · 已有内容可搜索`
                  : `已读取 ${index.items.length} 项内容`}
                {index.errors.length ? " · 部分内容未读取" : ""}
              </summary>
              <div>
                <p>
                  搜索资料名称与说明、通知与作业正文，以及本机 PDF
                  的文字（已读取 {index.pdfs} 份）。回放目前按标题搜索。
                </p>
                {index.errors.map((e) => (
                  <p key={e}>{e}</p>
                ))}
              </div>
            </details>
            <label>
              <input
                type="checkbox"
                checked={allTerms}
                onChange={(e) => {
                  setAllTerms(e.target.checked);
                  update({ course: "", selected: undefined });
                }}
              />
              全部学期
            </label>
            <button
              className="icon-button"
              aria-label="刷新搜索内容"
              disabled={index.busy}
              onClick={() => setRevision((n) => n + 1)}
            >
              <RefreshCw size={14} className={index.busy ? "spin" : ""} />
            </button>
            <span className="search-key-hint">↑ ↓ 选择　↵ 打开　esc 返回</span>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
