import FacultyNotices from "../components/FacultyNotices";
import { useEffect, useMemo, useState } from "react";
import {
  CheckCheck,
  ChevronLeft,
  Inbox,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react";
import {
  useNotifications,
  sources,
  newsDate,
  type NewsItem,
} from "../lib/notifications";
import { openOfficial } from "../lib/api";
import { openBrowser } from "../lib/browser";
import { Button, Empty, Modal, Search, type Login } from "../components/ui";

export function NoticeReader({
  item,
  close,
  login,
}: {
  item: NewsItem;
  close: () => void;
  login: Login;
}) {
  const [error, setError] = useState("");
  const news = useNotifications();
  async function open() {
    try {
      if (item.url) await openBrowser(item.url, item.title);
      else if (item.source === "course") await openOfficial("course");
    } catch {
      setError("未能打开原文，请刷新后重试");
    }
  }
  return (
    <article className="news-reader">
      <div className="reader-toolbar">
        <button className="text-button" onClick={close}>
          <ChevronLeft size={16} />
          返回列表
        </button>
        <button
          className="text-button"
          onClick={() => news.markRead([item.key], !news.isRead(item.key))}
        >
          {news.isRead(item.key) ? "标为未读" : "标为已读"}
        </button>
        <Button variant="quiet" onClick={() => void open()}>
          查看原文
        </Button>
      </div>
      <div className="reader-meta">
        {item.department}
        <span>·</span>
        {item.dateLabel} {newsDate(item.date)}
      </div>
      <h2>{item.title}</h2>
      {item.source === "library" && (
        <dl className="event-details">
          <dt>时间</dt>
          <dd>
            {item.eventStart || "以原文为准"}
            {item.eventEnd
              ? ` — ${item.eventEnd.startsWith(item.eventStart?.slice(0, 10) || "_") ? item.eventEnd.slice(11) : item.eventEnd}`
              : ""}
            （北京时间）
          </dd>
          {item.location && (
            <>
              <dt>地点</dt>
              <dd>{item.location}</dd>
            </>
          )}
          {item.speaker && (
            <>
              <dt>讲者</dt>
              <dd>{item.speaker}</dd>
            </>
          )}
        </dl>
      )}
      {item.source === "course" ? (
        <div className="article-body">
          <p>
            {item.body ||
              "这条通知的正文未提取到，请打开教学网查看图片或附件。"}
          </p>
          {item.author && <p className="subtle">{item.author}</p>}
        </div>
      ) : (
        <Button onClick={() => void open()}>在原文窗口阅读</Button>
      )}
      {error && <p role="status">{error}</p>}
    </article>
  );
}
export default function Notices({ login }: { login: Login }) {
  const news = useNotifications();
  const [source, setSource] = useState("all");
  const [search, setSearch] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [selected, setSelected] = useState<NewsItem>();
  const [manage, setManage] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (
      selected &&
      selected.source === "course" &&
      !news.items.some((n) => n.key === selected.key)
    )
      setSelected(undefined);
  }, [news.items, selected]);
  const items = useMemo(
    () =>
      news.items.filter(
        (n) =>
          (source === "all" || n.source === source) &&
          (!unreadOnly || !news.isRead(n.key)) &&
          `${n.title} ${n.department} ${n.location ?? ""} ${n.speaker ?? ""}`
            .toLowerCase()
            .includes(search.trim().toLowerCase()),
      ),
    [news.items, source, search, unreadOnly, news.isRead],
  );
  useEffect(() => {
    if (
      source !== "all" &&
      source !== "faculty" &&
      !news.enabled.includes(source)
    )
      setSource("all");
  }, [source, news.enabled]);
  async function select(n: NewsItem) {
    try {
      setError("");
      if (n.url) {
        await openBrowser(n.url, n.title);
        setSelected(undefined);
      } else setSelected(n);
      news.markRead([n.key]);
    } catch {
      setError("原文窗口未能打开，请重试");
    }
  }
  return (
    <>
      <header className="page-heading">
        <div>
          <h1>通知</h1>
        </div>
        <div className="heading-actions">
          <Button variant="quiet" onClick={() => setManage(true)}>
            <SlidersHorizontal size={16} />
            订阅来源
          </Button>
          {source !== "faculty" && (
            <Button onClick={() => void news.refresh()} disabled={news.busy}>
              <RefreshCw size={16} className={news.busy ? "spin" : ""} />
              刷新
            </Button>
          )}
        </div>
      </header>
      <div className="news-filters">
        <div className="news-tools">
          {source !== "faculty" && (
            <Search
              value={search}
              onChange={(value) => {
                setSearch(value);
                setSelected(undefined);
              }}
              placeholder="搜索已加载的通知"
            />
          )}
          <select
            aria-label="通知来源"
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              setSelected(undefined);
            }}
          >
            <option value="all">全部来源</option>
            <option value="faculty">本院通知</option>
            {sources
              .filter((s) => news.enabled.includes(s.id))
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
          {source !== "faculty" && (
            <>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={unreadOnly}
                  onChange={(e) => {
                    setUnreadOnly(e.target.checked);
                    setSelected(undefined);
                  }}
                />
                只看未读
              </label>
              <span className="news-count" aria-live="polite">
                {items.length} 条 ·{" "}
                {items.filter((n) => !news.isRead(n.key)).length} 条未读
              </span>
              <button
                className="text-button"
                disabled={!items.some((n) => !news.isRead(n.key))}
                onClick={() => news.markRead(items.map((n) => n.key))}
              >
                <CheckCheck size={16} />
                本页已读
              </button>
            </>
          )}
        </div>
      </div>
      {source !== "faculty" && news.issues.length > 0 && (
        <div className="feed-issues" role="status">
          {news.issues.map((i) => (
            <span key={i.source}>
              {sources.find((s) => s.id === i.source)?.name}：{i.message}
              <button
                className="text-button"
                onClick={() => void news.refreshSource(i.source)}
              >
                重试
              </button>
              {i.source === "course" && (
                <button className="text-button" onClick={() => login("course")}>
                  连接
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {source === "faculty" ? (
        <FacultyNotices login={login} select={(n) => void select(n)} />
      ) : (
        <div
          className={`news-workspace ${selected ? "has-selection" : "index-only"}`}
        >
          <section className="news-index" aria-label="通知列表">
            {items.length ? (
              <div className="news-rows">
                {items.map((n) => (
                  <button
                    key={n.key}
                    className={`news-row ${news.isRead(n.key) ? "read" : "unread"} ${selected?.key === n.key ? "selected" : ""}`}
                    onClick={() => void select(n)}
                  >
                    <span className="unread-dot" aria-hidden="true" />
                    <span className="sr-only">
                      {news.isRead(n.key) ? "已读" : "未读"}
                    </span>
                    <div className="grow">
                      <div className="news-row-meta">
                        <span>{n.department}</span>
                        <time>
                          {n.dateLabel} {newsDate(n.date).slice(5)}
                        </time>
                      </div>
                      <strong>{n.title}</strong>
                      {n.eventStart && (
                        <span className="news-event-time">
                          活动 · {n.eventStart}（北京）
                        </span>
                      )}
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
              <Empty icon={<Inbox />}>
                {search
                  ? "没有找到匹配的通知"
                  : unreadOnly
                    ? "未读通知已看完"
                    : "这个来源暂无已加载通知"}
              </Empty>
            )}
            {source !== "all" && news.hasMore(source) && (
              <div className="load-more">
                <Button
                  disabled={news.busy}
                  onClick={() =>
                    void news
                      .loadMore(source)
                      .catch(() => setError("更多通知未能加载，请重试"))
                  }
                >
                  加载更早通知
                </Button>
              </div>
            )}
            {source === "all" && (
              <p className="footnote index-footnote">
                汇集各来源最新通知；选择来源可继续查看。
              </p>
            )}
          </section>
          {selected ? (
            <NoticeReader
              key={selected.key}
              item={selected}
              close={() => setSelected(undefined)}
              login={login}
            />
          ) : null}
        </div>
      )}
      {(error || news.storageError) && (
        <p role="status">{error || news.storageError}</p>
      )}
      {manage && (
        <Modal
          open
          title="订阅来源"
          description="已接入的来源可独立开启；更改立即保存在本机。"
          onClose={() => setManage(false)}
        >
          <div className="source-options">
            {sources.map((s) => (
              <label key={s.id}>
                <input
                  type="checkbox"
                  checked={news.enabled.includes(s.id)}
                  onChange={(e) =>
                    news.setEnabled(
                      e.target.checked
                        ? [...news.enabled, s.id]
                        : news.enabled.filter((x) => x !== s.id),
                    )
                  }
                />
                <span>
                  <strong>{s.name}</strong>
                  <small>{s.description}</small>
                </span>
              </label>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}
