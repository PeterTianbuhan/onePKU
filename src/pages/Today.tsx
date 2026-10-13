import { useState } from "react";
import { BookOpenText, Clock3, FileCheck2, MapPin } from "lucide-react";
import { useResource, type Assignment, fmtTime } from "../lib/api";
import {
  useNotifications,
  newsDate,
  type NewsItem,
} from "../lib/notifications";
import { Button, Empty, Resource, Modal, type Login } from "../components/ui";
import { openBrowser } from "../lib/browser";
import { NoticeReader } from "./Notices";
import { pageLink } from "../lib/navigation";
import CampusCard, { type Card } from "../components/CampusCard";
/** 与安卓端一致：24 小时内显示倒计时，其余显示日期。 */
function deadlineLabel(deadline: string): string {
  const left = Date.parse(deadline) - Date.now();
  if (left > 0 && left < 24 * 60 * 60 * 1000) {
    const minutes = Math.ceil(left / 60000);
    return minutes >= 60
      ? `剩余 ${Math.floor(minutes / 60)} 小时`
      : `剩余 ${minutes} 分钟`;
  }
  return fmtTime(deadline);
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
  const news = useNotifications();
  const date = new Date().toLocaleDateString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "long",
    day: "numeric",
    weekday: "long",
  });
  const latest = news.items.slice(0, 3);
  return (
    <>
      <header className="page-heading">
        <div>
          <div className="eyebrow">{date} · 北京时间</div>
          <h1>今日</h1>
        </div>
      </header>
      <div className="today-grid refreshed-today">
        <div className="column">
          <Resource
            title="作业"
            q={assignments}
            service="course"
            login={login}
            extra={
              <button className="text-button" onClick={() => navigate("作业")}>
                查看全部
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
                  {items.map((a) => (
                    <button
                      className="assignment-row"
                      key={a.hash_id}
                      onClick={() =>
                        navigate(pageLink("作业", { assignment: a.hash_id }))
                      }
                    >
                      <span
                        className={`task-mark ${a.last_attempt ? "completed" : ""}`}
                      >
                        <FileCheck2 size={17} />
                      </span>
                      <span className="grow">
                        <strong>{a.title}</strong>
                        <small>{a.course_name}</small>
                      </span>
                      <span
                        className={`deadline ${
                          !a.last_attempt && a.deadline
                            ? Date.parse(a.deadline) < Date.now()
                              ? "overdue"
                              : Date.parse(a.deadline) - Date.now() <
                                  24 * 60 * 60 * 1000
                                ? "urgent"
                                : ""
                            : ""
                        }`}
                      >
                        {a.detail_error ? (
                          "详情待更新"
                        ) : a.last_attempt ? (
                          "有提交记录"
                        ) : a.deadline ? (
                          <>
                            <Clock3 size={12} />
                            {deadlineLabel(a.deadline)}
                          </>
                        ) : null}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <Empty>没有待处理作业</Empty>
              );
            }}
          </Resource>
          <section className="resource today-news">
            <div className="resource-head">
              <h2>最新通知</h2>
              <button className="text-button" onClick={() => navigate("通知")}>
                查看全部
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
                      <div className="news-row-meta">
                        <span>{n.department}</span>
                        <time>{newsDate(n.date).slice(5)}</time>
                      </div>
                      <strong>{n.title}</strong>
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
                data.map((c, i) => <CampusCard key={i} card={c} />)
              ) : (
                <Empty>暂无校园卡</Empty>
              )
            }
          </Resource>
          <section className="quick-links compact-links">
            <h2>常用</h2>
            <button onClick={() => navigate("校历")}>
              <BookOpenText size={17} />
              <span>
                <strong>学校校历</strong>
              </span>
            </button>
            <button onClick={() => navigate("空闲教室")}>
              <MapPin size={17} />
              <span>
                <strong>找间自习教室</strong>
              </span>
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
