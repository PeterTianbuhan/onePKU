import { useState } from "react";
import { ArrowLeft, Inbox } from "lucide-react";
import { useResource, type Notice } from "../lib/api";
import {
  htmlToText,
  legacyNoticeKey,
  noticeKey,
  newsDate,
  useNotifications,
} from "../lib/notifications";
import { openBrowser } from "../lib/browser";
import { Button, Empty, Resource, type Login } from "./ui";
export default function CourseNotices({
  course,
  login,
}: {
  course: string;
  login: Login;
}) {
  const q = useResource<Notice[]>({ kind: "courseNotices", course });
  const news = useNotifications();
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Notice>();
  const generation = q.data?.generation ?? "";
  const keyFor = (n: Notice) => noticeKey(n, generation);
  const keysFor = (n: Notice) => [keyFor(n), legacyNoticeKey(n, generation)];
  const read = (n: Notice) => keysFor(n).some(news.isRead);
  function open(n: Notice) {
    // 与安卓端一致：课程通知直接在应用内读正文，原文窗口只是兜底。
    setSelected(n);
    news.markRead(keysFor(n));
  }
  async function openOfficial(n: Notice) {
    setError("");
    try {
      if (!n.announcement.url) throw Error("通知原文地址缺失，请刷新后重试");
      await openBrowser(n.announcement.url, n.announcement.title);
    } catch (e) {
      setError(e instanceof Error ? e.message : "原文窗口未能打开，请重试");
    }
  }
  if (selected) {
    const body = htmlToText(selected.announcement.body ?? "");
    return (
      <>
        <Button
          variant="quiet"
          className="back-link"
          onClick={() => setSelected(undefined)}
        >
          <ArrowLeft size={17} />
          课程通知
        </Button>
        <article className="news-reader">
          <div className="news-row-meta">
            <span>{selected.announcement.author}</span>
            <time>{newsDate(selected.announcement.date)}</time>
          </div>
          <h2>{selected.announcement.title}</h2>
          <div className="article-body">
            {body ? (
              body
                .split(/\n\n+/)
                .map((paragraph, i) => <p key={i}>{paragraph}</p>)
            ) : (
              <p>这条通知的正文未提取到，请打开教学网查看图片或附件。</p>
            )}
          </div>
          <Button variant="quiet" onClick={() => void openOfficial(selected)}>
            在原文窗口打开
          </Button>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
        </article>
      </>
    );
  }
  return (
    <>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <Resource
        title="课程通知"
        className="resource-plain"
        heading={
          <span className="subtle">{q.data?.data?.length ?? 0} 条通知</span>
        }
        q={q}
        service="course"
        login={login}
        extra={
          q.data?.data?.some((n) => !read(n)) && (
            <Button
              variant="quiet"
              disabled={!q.data?.data?.some((n) => !read(n))}
              onClick={() =>
                news.markRead((q.data?.data ?? []).flatMap(keysFor))
              }
            >
              全部已读
            </Button>
          )
        }
      >
        {(data) =>
          data.length ? (
            <div className="news-rows course-notice-list">
              {data.map((n) => (
                <button
                  className={`news-row ${read(n) ? "read" : "unread"}`}
                  key={keyFor(n)}
                  onClick={() => void open(n)}
                >
                  <span className="unread-dot" aria-hidden="true" />
                  <span className="sr-only">{read(n) ? "已读" : "未读"}</span>
                  <div className="grow">
                    <div className="news-row-meta">
                      <span>{n.announcement.author}</span>
                      <time>{newsDate(n.announcement.date)}</time>
                    </div>
                    <strong>{n.announcement.title}</strong>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <Empty icon={<Inbox />}>暂无课程通知</Empty>
          )
        }
      </Resource>
    </>
  );
}
