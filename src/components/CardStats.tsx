import { useState, type ReactNode } from "react";
import { useResource, money } from "../lib/api";
import { Empty, Resource, type Login } from "./ui";
export default function CardStats({
  login,
  card,
  transactions,
}: {
  login: Login;
  card: ReactNode;
  transactions: ReactNode;
}) {
  const [view, setView] = useState("transactions");
  const [month, setMonth] = useState(() =>
    new Date()
      .toLocaleDateString("en-CA", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
      })
      .slice(0, 7),
  );
  const total = useResource<{ income: number; expenses: number }>(
    { kind: "cardStats", month, part: "total" },
    !!month,
  );
  const daily = useResource<Record<string, number>>(
    { kind: "cardStats", month, part: "daily" },
    !!month && view === "statistics",
  );
  const consumption = useResource<{ amount: number }>(
    { kind: "cardStats", month, part: "consumption" },
    !!month,
  );
  const category = useResource<
    { turnoverType: string | null; amount: number }[]
  >(
    { kind: "cardStats", month, part: "category" },
    !!month && view === "statistics",
  );
  return (
    <div className="card-statistics">
      <div className="card-overview">
        {card}
        <div className="month-summary">
          <div className="toolbar">
            <h2>月度收支</h2>
            <label>
              月份{" "}
              <input
                aria-label="统计月份"
                type="month"
                min="2000-01"
                max="2100-12"
                value={month}
                onChange={(e) => {
                  if (e.target.value) setMonth(e.target.value);
                }}
              />
            </label>
          </div>
          <Resource
            title="月度收支"
            className="resource-plain"
            heading={<span className="sr-only">{month} 收支</span>}
            q={total}
            login={login}
            service="campuscard"
          >
            {(d) => (
              <div className="study-metrics">
                <div>
                  <span>全部转出</span>
                  <strong>¥{money(d.expenses)}</strong>
                </div>
                <div>
                  <span>全部转入</span>
                  <strong>¥{money(d.income)}</strong>
                </div>
              </div>
            )}
          </Resource>
          <Resource
            title="月度消费"
            className="resource-plain"
            q={consumption}
            login={login}
            service="campuscard"
          >
            {(d) => (
              <div className="study-metrics">
                <div>
                  <span>消费支出</span>
                  <strong>¥{money(d.amount)}</strong>
                  <span>与下方消费统计口径一致</span>
                </div>
              </div>
            )}
          </Resource>
        </div>
      </div>
      <div className="tabs" aria-label="校园卡视图">
        <button
          className={view === "transactions" ? "active" : ""}
          aria-pressed={view === "transactions"}
          onClick={() => setView("transactions")}
        >
          收支明细
        </button>
        <button
          className={view === "statistics" ? "active" : ""}
          aria-pressed={view === "statistics"}
          onClick={() => setView("statistics")}
        >
          消费统计
        </button>
      </div>
      {view === "transactions" ? (
        transactions
      ) : (
        <div className="statistics-grid">
          <Resource
            title="每日支出"
            q={daily}
            login={login}
            service="campuscard"
          >
            {(d) => {
              const entries = Object.entries(d).sort(([a], [b]) =>
                a.localeCompare(b),
              );
              const max = Math.max(...entries.map(([, v]) => v), 1);
              return entries.length ? (
                <>
                  <div
                    className="daily-chart"
                    role="img"
                    aria-label={`${month}每日支出柱状图`}
                  >
                    {entries.map(([day, v]) => (
                      <div
                        className="day-bar"
                        key={day}
                        title={`${day}：¥${money(v)}`}
                      >
                        <span className="bar-track">
                          <i style={{ height: `${(v / max) * 100}%` }} />
                        </span>
                        <small>{Number(day.slice(-2))}</small>
                        <span className="sr-only">¥{money(v)}</span>
                      </div>
                    ))}
                  </div>
                  <details className="daily-detail">
                    <summary>查看每日明细</summary>
                    <div className="category-list">
                      {entries.map(([day, v]) => (
                        <div key={day}>
                          <span>{day}</span>
                          <strong>¥{money(v)}</strong>
                        </div>
                      ))}
                    </div>
                  </details>
                </>
              ) : (
                <Empty>本月尚无每日支出记录</Empty>
              );
            }}
          </Resource>
          <Resource
            title="支出分类"
            q={category}
            login={login}
            service="campuscard"
          >
            {(d) =>
              d.length ? (
                <div className="category-list">
                  {[...d]
                    .sort((a, b) => b.amount - a.amount)
                    .map((c, i) => (
                      <div key={i}>
                        <span>{c.turnoverType || "其他"}</span>
                        <strong>¥{money(c.amount)}</strong>
                      </div>
                    ))}
                </div>
              ) : (
                <Empty>本月尚无分类支出</Empty>
              )
            }
          </Resource>
        </div>
      )}
    </div>
  );
}
