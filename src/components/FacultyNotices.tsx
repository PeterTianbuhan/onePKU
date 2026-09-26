import { useState } from "react";
import { useResource } from "../lib/api";
import { normalizeProfile, useProfile } from "../lib/profile";
import { planIndex } from "../lib/curriculum";
import { Button, Empty, Resource, type Login } from "./ui";
import {
  type NewsItem,
  type NewsFeed,
  useNotifications,
} from "../lib/notifications";
import schools from "../../data/schools.json";

const names = Object.keys(schools).sort((a, b) => a.localeCompare(b, "zh"));
export default function FacultyNotices({
  login,
  select,
}: {
  login: Login;
  select: (item: NewsItem) => void;
}) {
  const profile = useProfile();
  const detected =
    planIndex.find((p) => p.id === normalizeProfile(profile.data?.data)?.planId)
      ?.school ?? "";
  const [manual, setManual] = useState(() => {
    try {
      return localStorage.getItem("onepku.news.faculty.v1") ?? "";
    } catch {
      return "";
    }
  });
  const school = names.includes(manual)
    ? manual
    : names.includes(detected)
      ? detected
      : "";
  const [pagination, setPagination] = useState({ school: "", page: 1 });
  const page = pagination.school === school ? pagination.page : 1;
  const [saveError, setSaveError] = useState("");
  const q = useResource<NewsFeed & { origin: string }>(
    { kind: "facultyNews", school, page },
    !!school,
  );
  const news = useNotifications();
  return (
    <section aria-label="本院通知">
      <div className="toolbar">
        <label>
          通知院系{" "}
          <select
            aria-label="通知院系"
            value={manual}
            onChange={(e) => {
              const value = e.target.value;
              setManual(value);
              setPagination({ school: "", page: 1 });
              try {
                localStorage.setItem("onepku.news.faculty.v1", value);
                setSaveError("");
              } catch {
                setSaveError("院系选择暂未保存");
              }
            }}
          >
            <option value="">
              {detected ? `跟随培养方案：${detected}` : "请选择院系"}
            </option>
            {names.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <Button
          disabled={!school || q.isFetching}
          onClick={() => void q.refetch()}
        >
          刷新本院通知
        </Button>
      </div>
      {saveError && <p role="status">{saveError}</p>}
      {!school ? (
        <Empty>选择院系，或在设置中选择培养方案。</Empty>
      ) : (
        <Resource title={`${school}通知`} q={q} login={login}>
          {(data) => (
            <>
              <p className="subtle">
                {data.origin}
                {data.origin === "门户部门通知"
                  ? ` · 第 ${page} 页院系筛选；当前页为空不代表没有更早通知。`
                  : page > 1
                    ? ` · 第 ${page} 页`
                    : " · 最新通知"}
              </p>
              {data.items.length ? (
                <div className="news-rows">
                  {data.items.map((n) => {
                    const item: NewsItem = {
                      ...n,
                      source: "faculty",
                      key: `faculty:${school}:${n.id}`,
                      generation: "public",
                    };
                    return (
                      <button
                        className={`news-row ${news.isRead(item.key) ? "read" : "unread"}`}
                        key={item.key}
                        onClick={() => select(item)}
                      >
                        <span className="unread-dot" aria-hidden="true" />
                        <div className="grow">
                          <div className="news-row-meta">
                            <span>{school}</span>
                            <time>{n.date}</time>
                          </div>
                          <strong>{n.title}</strong>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <Empty>当前页没有匹配的本院通知</Empty>
              )}
              <div className="toolbar">
                {page > 1 && (
                  <Button
                    onClick={() => setPagination({ school, page: page - 1 })}
                  >
                    上一页
                  </Button>
                )}
                {data.hasMore && (
                  <Button
                    onClick={() => setPagination({ school, page: page + 1 })}
                  >
                    查看更早通知
                  </Button>
                )}
              </div>
            </>
          )}
        </Resource>
      )}
    </section>
  );
}
