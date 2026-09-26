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
  BookOpen,
  FileCheck2,
  CalendarDays,
  Settings as SettingsIcon,
  Bell,
  CreditCard,
  MapPin,
  BookOpenText,
  GraduationCap,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { call, resetService, type LoginTarget } from "./lib/api";
import type { Login } from "./components/ui";
import Auth from "./components/Auth";
import Downloads from "./components/Downloads";
import Today from "./pages/Today";
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
import { readLocation } from "./lib/navigation";
import Settings, { type Session } from "./pages/Settings";
const pages = [
  "今日",
  "课程",
  "作业",
  "通知",
  "校历",
  "成绩",
  "培养方案",
  "空闲教室",
  "校园卡",
  "设置",
];
const groups = [
  {
    label: "学习",
    items: [
      { name: "今日", icon: CalendarDays },
      { name: "课程", icon: BookOpen },
      { name: "作业", icon: FileCheck2 },
      { name: "成绩", icon: BookOpenText },
      { name: "培养方案", icon: GraduationCap },
    ],
  },
  {
    label: "校园",
    items: [
      { name: "通知", icon: Bell },
      { name: "校历", icon: BookOpenText },
    ],
  },
  {
    label: "生活",
    items: [
      { name: "空闲教室", icon: MapPin },
      { name: "校园卡", icon: CreditCard },
    ],
  },
];
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
function initialPage() {
  try {
    const raw = readLocation().page;
    const p = raw === "成绩与考试" ? "成绩" : raw === "提醒" ? "今日" : raw;
    return pages.includes(p) ? p : "今日";
  } catch {
    return "今日";
  }
}
export default function App() {
  const [page, setPage] = useState(initialPage);
  const news = useNotifications();
  const [, tick] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [auth, setAuth] = useState<{
    service: LoginTarget;
    scope?: "treehole" | "timetable";
  }>();
  const queryClient = useQueryClient();
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
          {groups.map((group) => (
            <div className="nav-group" key={group.label}>
              <div className="nav-group-label">{group.label}</div>
              {group.items.map(({ name: p, icon: Icon }) => (
                <button
                  key={p}
                  className={page === p ? "active" : ""}
                  aria-current={page === p ? "page" : undefined}
                  title={p}
                  onClick={() => navigate(p)}
                >
                  <Icon size={19} />
                  <span>{p}</span>
                  {p === "通知" && news.unread > 0 && (
                    <span className="nav-badge">
                      {news.unread > 99 ? "99+" : news.unread}
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <Downloads />
          <button
            className={`nav-settings ${page === "设置" ? "active" : ""}`}
            onClick={() => navigate("设置")}
            title="设置"
          >
            <SettingsIcon size={19} />
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
            {page === "今日" ? (
              <Today login={login} navigate={navigate} />
            ) : page === "作业" ? (
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
