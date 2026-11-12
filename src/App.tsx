import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  Component,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Award,
  Bell,
  BookOpen,
  CalendarRange,
  CreditCard,
  FileCheck2,
  GraduationCap,
  MapPin,
  PanelLeftClose,
  PanelLeftOpen,
  ChevronRight,
  Settings as SettingsIcon,
} from "lucide-react";
import {
  call,
  resetService,
  useResource,
  type Course,
  type Service,
} from "./lib/api";
import { listen } from "@tauri-apps/api/event";
import type { Login } from "./components/ui";
import Auth from "./components/Auth";
import Downloads from "./components/Downloads";
import Courses from "./pages/Courses";
import Assignments from "./pages/Assignments";
import Grades from "./pages/Grades";
import Curriculum from "./pages/Curriculum";
import { normalizeProfile, onboardingSeenKey } from "./lib/profile";
import { CardPage, Rooms } from "./pages/Life";
import Notices from "./pages/Notices";
import SearchWorkspace from "./components/SearchWorkspace";
const Calendar = lazy(() => import("./pages/Calendar"));
import { useNotifications } from "./lib/notifications";
import { pageLink, readLocation, usePageParams } from "./lib/navigation";
import { useCourseStatus } from "./lib/courseStatus";
import CourseGlyph from "./components/CourseGlyph";
import Settings, { type Session } from "./pages/Settings";
const pages = [
  "课程",
  "作业",
  "通知",
  "成绩",
  "培养方案",
  "校历",
  "空闲教室",
  "校园卡",
  "设置",
];
/** 跨课程的三页：所有课的作业、学校和课程的通知、正式成绩。 */
const across = [
  { name: "作业", icon: FileCheck2 },
  { name: "通知", icon: Bell },
  { name: "成绩", icon: Award },
];
/** 不常用的收在「更多」里，默认折起来。 */
const more = [
  { name: "培养方案", icon: GraduationCap },
  { name: "校历", icon: CalendarRange },
  { name: "空闲教室", icon: MapPin },
  { name: "校园卡", icon: CreditCard },
];
const moreKey = "onepku.nav.more.v1";
const lastKey = "onepku.nav.last.v1";
function stored(key: string) {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 记不住只是下次从默认页开始 */
  }
}
class Boundary extends Component<{ children: ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <div className="empty">
        <h2>这一页遇到了问题</h2>
        <button
          className="button"
          onClick={() => this.setState({ error: false })}
        >
          重新打开
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}
/** 旧版的页面名：今日页和提醒页都并进了作业页。 */
function pageName(raw: string) {
  const p =
    raw === "成绩与考试"
      ? "成绩"
      : raw === "提醒" || raw === "今日"
        ? "作业"
        : raw;
  return pages.includes(p) ? p : "";
}
/** 打开应用时回到上次停的那一页（哪门课也记得）；没有记录就从作业页开始。 */
function restoreLocation() {
  try {
    if (pageName(readLocation().page)) return;
    const last = stored(lastKey);
    const known = pageName(last.split("?")[0]);
    history.replaceState(
      null,
      "",
      `#${encodeURIComponent(known ? last : "作业")}`,
    );
  } catch {
    /* 读不到地址就按默认页显示 */
  }
}
function initialPage() {
  try {
    return pageName(readLocation().page) || "作业";
  } catch {
    return "作业";
  }
}
export default function App() {
  const [page, setPage] = useState(() => {
    restoreLocation();
    return initialPage();
  });
  const news = useNotifications();
  const [, tick] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [auth, setAuth] = useState<{
    service: Service;
    scope?: "treehole" | "timetable";
  }>();
  const queryClient = useQueryClient();
  // 课堂实录的登录窗口是自己关的：登录成功就刷新所有资源，回放列表立刻出现。
  useEffect(() => {
    let dispose: (() => void) | undefined;
    // 浏览器预览里没有 Tauri 事件通道，不订阅。
    if (!("__TAURI_INTERNALS__" in window)) return;
    void listen("haoxue-connected", () => {
      void queryClient.invalidateQueries({ queryKey: ["resource"] });
    }).then((unlisten) => {
      dispose = unlisten;
    });
    return () => dispose?.();
  }, [queryClient]);
  useEffect(() => {
    let date = new Date().toLocaleDateString("en-CA", {
      timeZone: "Asia/Shanghai",
    });
    const timer = setInterval(() => {
      tick((n) => n + 1);
      const next = new Date().toLocaleDateString("en-CA", {
        timeZone: "Asia/Shanghai",
      });
      if (next !== date) {
        date = next;
        void queryClient.invalidateQueries({ queryKey: ["resource"] });
      }
    }, 60000);
    return () => clearInterval(timer);
  }, [queryClient]);

  const last = useRef<Record<string, string>>({});
  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: () => call<Session[]>({ kind: "sessions" }),
    refetchInterval: 10000,
    retry: false,
  });
  useEffect(() => {
    for (const session of sessions.data?.data ?? []) {
      if (
        last.current[session.service] &&
        last.current[session.service] !== session.generation
      )
        resetService(queryClient, session.service);
      last.current[session.service] = session.generation;
    }
  }, [sessions.data, queryClient]);
  useEffect(() => {
    const onHash = () => setPage(initialPage());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  // 侧栏直接列出本学期的课：哪门有作业待交、哪门有通知没读，一眼看到。
  const courses = useResource<Course[]>({ kind: "allCourses" });
  const current = (courses.data?.data ?? []).filter((c) => c.current);
  const status = useCourseStatus();
  const [courseParams] = usePageParams("课程");
  const openCourse = page === "课程" ? courseParams.get("course") : null;
  const due = [...status.values()].reduce((sum, s) => sum + s.due, 0);
  const [moreOpen, setMoreOpen] = useState(() => stored(moreKey) === "1");
  const showMore = moreOpen || more.some((item) => item.name === page);
  // 记住停在哪一页、哪门课；具体哪项作业、哪节回放不记，下次从那门课开始。
  useEffect(() => {
    store(
      lastKey,
      page === "课程" && openCourse
        ? pageLink("课程", { course: openCourse })
        : page,
    );
  }, [page, openCourse]);
  useLayoutEffect(() => {
    const main = document.getElementById("main");
    if (main) {
      main.scrollTop = 0;
      main.focus({ preventScroll: true });
    }
  }, [page]);
  const navigate = useCallback((p: string) => {
    location.hash = encodeURIComponent(p);
    setPage(initialPage());
  }, []);
  const login: Login = (service, scope) => setAuth({ service, scope });
  // 首次使用：已连接任一服务且没有保存过资料时，引导到培养方案页确认年级与专业。只做一次。
  const profile = useQuery({
    queryKey: ["resource", { kind: "profile" }],
    queryFn: () => call<unknown>({ kind: "profile" }),
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
  useEffect(() => {
    if (!profile.data || profile.data.error) return;
    const connected = (sessions.data?.data ?? []).some((s) =>
      ["saved", "verified"].includes(s.state),
    );
    if (!connected) return;
    let seen = "";
    try {
      seen = localStorage.getItem(onboardingSeenKey) ?? "";
    } catch {
      seen = "";
    }
    if (seen || normalizeProfile(profile.data.data) !== null) return;
    try {
      localStorage.setItem(onboardingSeenKey, new Date().toISOString());
    } catch {
      /* 本地存储不可用时不重复引导 */
    }
    navigate("培养方案");
  }, [profile.data, sessions.data, navigate]);

  return (
    <div className={`app ${collapsed ? "compact-nav" : ""}`}>
      <a
        className="skip-link"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main")?.focus();
        }}
      >
        跳转到主内容
      </a>
      {/* 只有 macOS 的融合标题栏会显示它：拖这一条就是拖窗口。 */}
      <div className="titlebar" data-tauri-drag-region />
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">未</span>
          <strong>OnePKU</strong>
        </div>
        <nav aria-label="主导航">
          <SearchWorkspace
            key={
              sessions.data?.data?.find((s) => s.service === "course")
                ?.generation ?? ""
            }
            generation={
              sessions.data?.data?.find((s) => s.service === "course")
                ?.generation ?? ""
            }
          />
          <div className="nav-group">
            <div className="nav-group-label">本学期</div>
            {current.map((c) => {
              const state = status.get(c.id);
              const hint = [
                state?.due && `${state.due} 项作业待交`,
                state?.unread && `${state.unread} 条通知未读`,
              ].filter(Boolean);
              return (
                <button
                  key={c.id}
                  className={`nav-course ${openCourse === c.id ? "active" : ""}`}
                  aria-current={openCourse === c.id ? "page" : undefined}
                  title={[c.name, ...hint].join(" · ")}
                  onClick={() => navigate(pageLink("课程", { course: c.id }))}
                >
                  <span className="nav-glyph">
                    <CourseGlyph name={c.name} />
                    {!!state?.unread && (
                      <i className="nav-dot" aria-label="有通知未读" />
                    )}
                  </span>
                  <span className="nav-name">{c.name}</span>
                  {!!state?.due && (
                    <span className="nav-badge">{state.due}</span>
                  )}
                </button>
              );
            })}
            <button
              className={
                page === "课程" && !current.some((c) => c.id === openCourse)
                  ? "active"
                  : ""
              }
              title="全部课程"
              onClick={() => navigate("课程")}
            >
              <BookOpen size={17} />
              <span>全部课程</span>
            </button>
          </div>
          <div className="nav-group">
            <div className="nav-group-label">汇总</div>
            {across.map(({ name: p, icon: Icon }) => {
              const count = p === "作业" ? due : p === "通知" ? news.unread : 0;
              return (
                <button
                  key={p}
                  className={page === p ? "active" : ""}
                  aria-current={page === p ? "page" : undefined}
                  title={p}
                  onClick={() => navigate(p)}
                >
                  <Icon size={17} />
                  <span>{p}</span>
                  {count > 0 && (
                    <span className="nav-badge">
                      {count > 99 ? "99+" : count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <div className="nav-group">
            <button
              className="nav-more"
              aria-expanded={showMore}
              title="更多"
              onClick={() => {
                store(moreKey, showMore ? "" : "1");
                setMoreOpen(!showMore);
              }}
            >
              <ChevronRight size={17} />
              <span>更多</span>
            </button>
            {showMore &&
              more.map(({ name: p, icon: Icon }) => (
                <button
                  key={p}
                  className={page === p ? "active" : ""}
                  aria-current={page === p ? "page" : undefined}
                  title={p}
                  onClick={() => navigate(p)}
                >
                  <Icon size={17} />
                  <span>{p}</span>
                </button>
              ))}
          </div>
        </nav>
        <div className="sidebar-bottom">
          <Downloads />
          <button
            className={`nav-settings ${page === "设置" ? "active" : ""}`}
            onClick={() => navigate("设置")}
            title="设置"
          >
            <SettingsIcon size={17} />
            <span>设置</span>
          </button>
          <div className="sidebar-status">
            <i
              className={
                sessions.data?.error || sessions.error ? "offline" : ""
              }
            />
            <span>本地运行</span>
            <button
              className="icon-button collapse"
              aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
              onClick={() => setCollapsed(!collapsed)}
            >
              {collapsed ? (
                <PanelLeftOpen size={15} />
              ) : (
                <PanelLeftClose size={15} />
              )}
            </button>
          </div>
        </div>
      </aside>
      <main id="main" tabIndex={-1}>
        <div className="page" key={page}>
          <Boundary
            key={(sessions.data?.data ?? []).map((s) => s.generation).join(":")}
          >
            {page === "作业" ? (
              <Assignments login={login} />
            ) : page === "课程" ? (
              <Courses login={login} />
            ) : page === "成绩" ? (
              <Grades login={login} />
            ) : page === "培养方案" ? (
              <Curriculum login={login} navigate={navigate} />
            ) : page === "通知" ? (
              <Notices login={login} />
            ) : page === "校历" ? (
              <Suspense
                fallback={
                  <div className="skeleton" aria-label="正在打开校历">
                    <i />
                    <i />
                  </div>
                }
              >
                <Calendar />
              </Suspense>
            ) : page === "空闲教室" ? (
              <>
                <header className="page-heading">
                  <h1>空闲教室</h1>
                </header>
                <Rooms login={login} />
              </>
            ) : page === "校园卡" ? (
              <>
                <header className="page-heading">
                  <h1>校园卡</h1>
                </header>
                <CardPage login={login} />
              </>
            ) : (
              <Settings
                login={login}
                sessions={sessions.data?.data ?? undefined}
              />
            )}
          </Boundary>
        </div>
      </main>
      {auth && (
        <Auth
          key={`${auth.service}:${auth.scope}`}
          {...auth}
          onClose={() => {
            setAuth(undefined);
            void queryClient.invalidateQueries({ queryKey: ["sessions"] });
          }}
        />
      )}
    </div>
  );
}
