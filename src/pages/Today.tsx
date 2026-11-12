import { useState } from "react";
import { CalendarRange, ChevronRight, MapPin } from "lucide-react";
import { useResource, type Assignment, type Course, fmtTime } from "../lib/api";
import {
  useNotifications,
  newsDate,
  type NewsItem,
} from "../lib/notifications";
import { Empty, Resource, Modal, type Login } from "../components/ui";
import { openBrowser } from "../lib/browser";
import { NoticeReader } from "./Notices";
import { pageLink } from "../lib/navigation";
import CampusCard, { type Card } from "../components/CampusCard";
import CourseGlyph from "../components/CourseGlyph";
import DueStamp, { dueTone } from "../components/DueStamp";
import TodayHero from "../components/TodayHero";
import DeadlineRuler from "../components/DeadlineRuler";

const DAY = 24 * 60 * 60 * 1000;
const beijingDay = (time: number) =>
  new Date(time).toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
const beijing = (time: number, options: Intl.DateTimeFormatOptions) =>
  new Date(time).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    ...options,
  });
/** 与安卓端一致：24 小时内显示倒计时。更远的按北京时间的日历日说「明天 / 后天 / 几天后」。 */
function deadlineLabel(deadline: string, now: number): string {
  const due = Date.parse(deadline);
  const left = due - now;
  if (left <= 0) return "已截止";
  if (left < DAY) {
    const minutes = Math.ceil(left / 60000);
    return minutes >= 60
      ? `剩余 ${Math.floor(minutes / 60)} 小时`
      : `剩余 ${minutes} 分钟`;
  }
  const days = Math.round(
    (Date.parse(beijingDay(due)) - Date.parse(beijingDay(now))) / DAY,
  );
  const clock = beijing(due, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return days === 1
    ? `明天 ${clock}`
    : days === 2
      ? `后天 ${clock}`
      : `${days} 天后`;
}

export default function Today({
  login,
  navigate,
}: {
  login: Login;
  navigate: (page: string) => void;
}) {
  const [notice, setNotice] = useState<NewsItem>();
  const [noticeError, setNoticeError] = useState("");
  const assignments = useResource<Assignment[]>({ kind: "assignments" });
  const card = useResource<Card[]>({ kind: "card" });
  const courses = useResource<Course[]>({ kind: "allCourses" });
  const news = useNotifications();
  const now = Date.now();
  const latest = news.items.slice(0, 4);
  const current = (courses.data?.data ?? []).filter((c) => c.current);
  // 页头一句话：只说已经读到的数，没读到的那一半不出现。
  const open = assignments.data?.data?.filter(
    (a) => !a.last_attempt && (!a.deadline || Date.parse(a.deadline) >= now),
  );
  const soon = open?.filter(
    (a) => a.deadline && Date.parse(a.deadline) - now < 3 * DAY,
  ).length;
  const brief = [
    open &&
      (open.length
        ? `${open.length} 项作业待交${soon ? `，${soon} 项三天内截止` : ""}`
        : "没有待交作业"),
    news.unread > 0 && `${news.unread} 条通知未读`,
  ].filter(Boolean);
  return (
    <>
      <TodayHero brief={brief.join(" · ")} />
      <DeadlineRuler
        assignments={assignments.data?.data ?? []}
        now={now}
        navigate={navigate}
      />
      <div className="today-grid">
        <div className="column">
          <Resource
            title="作业"
            q={assignments}
            service="course"
            login={login}
            extra={
              <button className="text-button" onClick={() => navigate("作业")}>
                全部作业
              </button>
            }
          >
            {(data) => {
              // 与安卓端一致：首页只截前 5 条，完整清单去作业页看。
              const items = data
                .filter((a) => !a.last_attempt)
                .sort(
                  (a, b) =>
                    (a.deadline ? Date.parse(a.deadline) : Infinity) -
                    (b.deadline ? Date.parse(b.deadline) : Infinity),
                )
                .slice(0, 5);
              return items.length ? (
                <div className="list">
                  {items.map((a) => {
                    const tone = dueTone(a.deadline, now);
                    return (
                      <button
                        className="assignment-row"
                        key={a.hash_id}
                        onClick={() =>
                          navigate(pageLink("作业", { assignment: a.hash_id }))
                        }
                      >
                        <DueStamp deadline={a.deadline} now={now} />
                        <span className="grow">
                          <strong>{a.title}</strong>
                          <small>{a.course_name}</small>
                        </span>
                        <span
                          className={`deadline ${tone}`}
                          title={a.deadline ? fmtTime(a.deadline) : undefined}
                        >
                          {a.detail_error
                            ? "详情待更新"
                            : a.deadline
                              ? deadlineLabel(a.deadline, now)
                              : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <Empty>没有待处理作业</Empty>
              );
            }}
          </Resource>
          <section className="resource today-news" aria-label="最新通知">
            <div className="resource-head">
              <h2>最新通知</h2>
              <button className="text-button" onClick={() => navigate("通知")}>
                全部通知
              </button>
            </div>
            {latest.length ? (
              <div className="news-rows">
                {latest.map((n) => (
                  <button
                    className={`news-row ${news.isRead(n.key) ? "read" : "unread"}`}
                    key={n.key}
                    onClick={() => {
                      if (n.url) {
                        void openBrowser(n.url, n.title)
                          .then(() => news.markRead([n.key]))
                          .catch(() =>
                            setNoticeError("原文窗口未能打开，请重试"),
                          );
                      } else {
                        setNotice(n);
                        news.markRead([n.key]);
                      }
                    }}
                  >
                    <span className="unread-dot" />
                    <div className="grow">
                      <strong>{n.title}</strong>
                      <div className="news-row-meta">
                        <span>{n.department}</span>
                        <time>{newsDate(n.date).slice(5)}</time>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            ) : news.busy ? (
              <div className="skeleton">
                <i />
                <i />
                <i />
              </div>
            ) : (
              <Empty>暂无已加载通知</Empty>
            )}
            {news.issues.length > 0 && (
              <button className="partial-link" onClick={() => navigate("通知")}>
                {news.issues.length} 个来源未能完整更新，查看详情
              </button>
            )}
          </section>
        </div>
        <div className="column">
          <Resource
            title="校园卡"
            q={card}
            login={login}
            service="campuscard"
            className="balance-card"
            extra={
              <button
                className="text-button"
                onClick={() => navigate("校园卡")}
              >
                收支明细
              </button>
            }
          >
            {(data) =>
              data.length ? (
                data.map((c, i) => <CampusCard key={i} card={c} plain />)
              ) : (
                <Empty>暂无校园卡</Empty>
              )
            }
          </Resource>
          {current.length > 0 && (
            <section className="resource shortcuts" aria-label="本学期课程">
              <div className="resource-head">
                <h2>本学期课程</h2>
                <button
                  className="text-button"
                  onClick={() => navigate("课程")}
                >
                  全部课程
                </button>
              </div>
              {current.map((c) => (
                <button
                  key={c.id}
                  onClick={() => navigate(pageLink("课程", { course: c.id }))}
                >
                  <CourseGlyph name={c.name} />
                  <strong>{c.name}</strong>
                  <ChevronRight size={15} aria-hidden="true" />
                </button>
              ))}
            </section>
          )}
          <section className="quick-links" aria-label="常用">
            <button onClick={() => navigate("校历")}>
              <CalendarRange size={18} />
              <strong>学校校历</strong>
            </button>
            <button onClick={() => navigate("空闲教室")}>
              <MapPin size={18} />
              <strong>找间自习教室</strong>
            </button>
          </section>
        </div>
      </div>
      {noticeError && <p role="alert">{noticeError}</p>}
      {notice && (
        <Modal title="通知详情" open wide onClose={() => setNotice(undefined)}>
          <NoticeReader
            item={notice}
            close={() => setNotice(undefined)}
            login={login}
          />
        </Modal>
      )}
    </>
  );
}
