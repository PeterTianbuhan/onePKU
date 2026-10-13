import {
  useEffect,
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useResource, call, type Notice } from "./api";

export const sources = [
  { id: "course", name: "课程通知", description: "本学期教学网课程" },
  { id: "school", name: "学校公告", description: "北京大学校级公告" },
  {
    id: "department",
    name: "各单位公告",
    description: "门户汇集的院系与部门公告",
  },
  {
    id: "college",
    name: "本院通知",
    description:
      "按校内门户识别或手动选择的院系读学院官网，读不到再回退门户部门公告",
  },
  { id: "dean", name: "教务部", description: "选课、考试、培养与交流" },
  { id: "library", name: "图书馆活动", description: "讲座、阅读活动与培训" },
];
export type NewsItem = {
  id: string;
  title: string;
  date: string;
  source: string;
  department: string;
  url?: string;
  key: string;
  body?: string;
  author?: string;
  courseId?: string;
  legacyKey?: string;
  dateLabel?: string;
  eventStart?: string;
  eventEnd?: string;
  location?: string;
  speaker?: string;
  generation: string;
};
export type NewsFeed = {
  items: Omit<NewsItem, "key" | "generation">[];
  hasMore: boolean;
  total?: number;
};
export function noticeKey(n: Notice, generation: string) {
  if (n.course_id && n.announcement.id)
    return `course:${generation}:${n.course_id}:${n.announcement.id}`;
  return legacyNoticeKey(n, generation);
}
export function legacyNoticeKey(n: Notice, generation: string) {
  return `course:${generation}:${n.course_name}:${n.announcement.title}:${n.announcement.date}`;
}
/** 教学网通知的正文是 HTML：应用内只展示文字，脚本样式与标签一律去掉。 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function newsDate(s: string) {
  const m = s.match(/(\d{4})[-年](\d{1,2})[-月](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : s;
}
function saved(key: string, fallback: string[]): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "null");
    return Array.isArray(v) && v.every((x) => typeof x === "string")
      ? v
      : fallback;
  } catch {
    return fallback;
  }
}
type State = {
  items: NewsItem[];
  unread: number;
  busy: boolean;
  issues: { source: string; message: string }[];
  enabled: string[];
  setEnabled: (ids: string[]) => void;
  isRead: (key: string) => boolean;
  markRead: (keys: string[], read?: boolean) => void;
  refresh: () => Promise<unknown>;
  refreshSource: (source: string) => Promise<unknown>;
  hasMore: (source: string) => boolean;
  loadMore: (source: string) => Promise<void>;
  storageError: string;
};
const Context = createContext<State | null>(null);
const KNOWN = sources.map((s) => s.id);
// 本院通知默认勾上；图书馆活动仍然只在手动订阅时读取。
const DEFAULT_SOURCES = KNOWN.filter((id) => id !== "library");
export function NotificationProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabledState] = useState<string[]>(() => {
    // 老用户勾过的「信息科学技术学院」换成范围更宽的本院通知；
    // 空列表是用户自己取消全部订阅，不给他重新勾上。
    const stored = saved("onepku.news.sources.v1", DEFAULT_SOURCES).map((id) =>
      id === "eecs" ? "college" : id,
    );
    return [...new Set(stored.filter((id) => KNOWN.includes(id)))];
  });
  const [read, setRead] = useState<string[]>(() =>
    saved("onepku.news.read.v1", []),
  );
  const [storageError, setStorageError] = useState("");
  const [extra, setExtra] = useState<
    Record<string, { items: NewsItem[]; page: number; hasMore: boolean }>
  >({});
  const [moreBusy, setMoreBusy] = useState(false);
  const course = useResource<Notice[]>(
    { kind: "notices" },
    enabled.includes("course"),
  );
  const school = useResource<NewsFeed>(
    { kind: "news", source: "school", page: 1 },
    enabled.includes("school"),
  );
  const department = useResource<NewsFeed>(
    { kind: "news", source: "department", page: 1 },
    enabled.includes("department"),
  );
  const college = useResource<NewsFeed>(
    { kind: "news", source: "college", page: 1 },
    enabled.includes("college"),
  );
  const dean = useResource<NewsFeed>(
    { kind: "news", source: "dean", page: 1 },
    enabled.includes("dean"),
  );
  const library = useResource<NewsFeed>(
    { kind: "news", source: "library", page: 1 },
    enabled.includes("library"),
  );
  const feeds = { school, department, college, dean, library };
  const all = { course, ...feeds };
  const readSet = useMemo(() => new Set(read), [read]);
  function store(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      setStorageError("");
    } catch {
      setStorageError("阅读偏好暂未保存，关闭应用后可能丢失");
    }
  }
  function setEnabled(ids: string[]) {
    const next = ids.filter((id) => sources.some((s) => s.id === id));
    setEnabledState(next);
    store("onepku.news.sources.v1", next);
  }
  function markRead(keys: string[], value = true) {
    const aliases = [
      ...keys,
      ...keys.flatMap((key) => {
        const item = items.find((n) => n.key === key);
        return item?.legacyKey ? [item.legacyKey] : [];
      }),
    ];
    setRead((old) => {
      const set = new Set(old);
      for (const key of aliases) {
        if (value) set.add(key);
        else set.delete(key);
      }
      const next = [...set].slice(-4000);
      return next;
    });
  }
  useEffect(() => {
    store("onepku.news.read.v1", read);
  }, [read]);
  const items: NewsItem[] = [];
  if (enabled.includes("course"))
    for (const n of course.data?.data ?? [])
      items.push({
        id: noticeKey(n, course.data!.generation),
        key: noticeKey(n, course.data!.generation),
        source: "course",
        courseId: n.course_id,
        url: n.announcement.url,
        legacyKey: legacyNoticeKey(n, course.data!.generation),
        department: n.course_name,
        title: n.announcement.title,
        date: newsDate(n.announcement.date),
        body: n.announcement.body,
        author: n.announcement.author,
        generation: course.data!.generation,
      });
  for (const [source, q] of Object.entries(feeds))
    if (enabled.includes(source)) {
      for (const n of q.data?.data?.items ?? [])
        items.push({
          ...n,
          key: `${source}:${n.id}`,
          generation: q.data!.generation,
        });
      items.push(...(extra[source]?.items ?? []));
    }
  const unique = [...new Map(items.map((i) => [i.key, i])).values()].sort(
    (a, b) => newsDate(b.date).localeCompare(newsDate(a.date)),
  );
  const issues = Object.entries(all)
    .filter(([source]) => enabled.includes(source))
    .flatMap(([source, q]) => {
      const message = q.data?.error?.message ?? q.error?.message;
      return message
        ? [{ source, message }]
        : q.data?.warnings.length
          ? [
              {
                source,
                message: `部分内容未更新（${q.data.warnings.length} 项）`,
              },
            ]
          : [];
    });
  async function loadMore(source: string) {
    if (!["school", "department", "library"].includes(source) || moreBusy)
      return;
    setMoreBusy(true);
    try {
      const page = (extra[source]?.page ?? 1) + 1;
      const env = await call<NewsFeed>({ kind: "news", source, page });
      if (env.error) throw Error(env.error.message);
      setExtra((old) => ({
        ...old,
        [source]: {
          page,
          hasMore: env.data?.hasMore ?? false,
          items: [
            ...(old[source]?.items ?? []),
            ...(env.data?.items ?? []).map((n) => ({
              ...n,
              key: `${source}:${n.id}`,
              generation: env.generation,
            })),
          ],
        },
      }));
    } finally {
      setMoreBusy(false);
    }
  }
  const isRead = (key: string) =>
    readSet.has(key) ||
    items.some(
      (n) => n.key === key && !!n.legacyKey && readSet.has(n.legacyKey),
    );
  const value: State = {
    items: unique,
    unread: unique.filter((n) => !isRead(n.key)).length,
    busy:
      moreBusy ||
      Object.entries(all).some(([s, q]) => enabled.includes(s) && q.isFetching),
    issues,
    enabled,
    setEnabled,
    isRead,
    markRead,
    storageError,
    refresh: () =>
      Promise.all(
        Object.entries(all)
          .filter(([s]) => enabled.includes(s))
          .map(([, q]) => q.refetch()),
      ),
    refreshSource: (s) =>
      all[s as keyof typeof all]?.refetch() ?? Promise.resolve(),
    hasMore: (s) =>
      extra[s]?.hasMore ??
      feeds[s as keyof typeof feeds]?.data?.data?.hasMore ??
      false,
    loadMore,
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useNotifications() {
  const v = useContext(Context);
  if (!v) throw Error("Missing notification provider");
  return v;
}
