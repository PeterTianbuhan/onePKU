import { useState } from "react";
import { MapPin } from "lucide-react";
import {
  useResource,
  money,
  transactionAmount,
  openOfficial,
} from "../lib/api";
import { Button, Empty, Resource, Pager, type Login } from "../components/ui";
import CardStats from "../components/CardStats";
import CampusCard, { type Card } from "../components/CampusCard";
type Transactions = {
  records: {
    resume: string;
    tranamt: number;
    cardBalance: number;
    effectdateStr: string;
    turnoverType: string;
    icon: string | null;
  }[];
  pages: number;
  total: number;
};
type Room = { room: string; capacity: string; occupied: boolean[] };
export function CardPage({ login }: { login: Login }) {
  const [page, setPage] = useState(1);
  const card = useResource<Card[]>({ kind: "card" });
  const transactions = useResource<Transactions>({
    kind: "transactions",
    page,
  });
  return (
    <>
      <CardStats
        login={login}
        card={
          <Resource
            className="balance-card life-balance"
            title="账户"
            extra={
              <Button onClick={() => void openOfficial("campuscard")}>
                充值与支付
              </Button>
            }
            q={card}
            login={login}
            service="campuscard"
          >
            {(data) =>
              data.length ? (
                data.map((c, i) => <CampusCard key={i} card={c} />)
              ) : (
                <Empty>没有校园卡</Empty>
              )
            }
          </Resource>
        }
        transactions={
          <Resource
            title="收支明细"
            heading={
              <h2>
                近期交易 <span className="subtle">· 不限月份</span>
              </h2>
            }
            className="resource-plain transaction-list"
            q={transactions}
            login={login}
            service="campuscard"
          >
            {(data) =>
              data.records.length ? (
                <>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>交易</th>
                          <th>时间</th>
                          <th className="numeric">金额</th>
                          <th className="numeric">交易后余额</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.records.map((r, i) => (
                          <tr key={i}>
                            <td>
                              <strong>
                                {r.resume?.replace(/-电子账户消费$/, "") ||
                                  r.turnoverType ||
                                  "校园卡交易"}
                              </strong>
                            </td>
                            <td className="subtle">
                              <time title={r.effectdateStr}>
                                {r.effectdateStr.replace(/:\d{2}$/, "")}
                              </time>
                            </td>
                            <td
                              className={`numeric ${["recharge", "subsidy", "refund"].includes(r.icon ?? "") ? "success" : ""}`}
                            >
                              {transactionAmount(r.tranamt, r.icon)}
                            </td>
                            <td className="numeric subtle">
                              ¥{money(r.cardBalance)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {(data.pages > 1 || page > 1) && (
                    <Pager
                      page={page}
                      onChange={setPage}
                      hasNext={page < data.pages}
                      busy={transactions.isFetching}
                    />
                  )}
                </>
              ) : (
                <Empty>没有收支记录</Empty>
              )
            }
          </Resource>
        }
      />
    </>
  );
}
export function Rooms({ login }: { login: Login }) {
  const [building, setBuilding] = useState("一教");
  const [day, setDay] = useState("today");
  const [slot, setSlot] = useState(0);
  const q = useResource<Room[]>({ kind: "rooms", building, day });
  return (
    <>
      <div className="toolbar room-toolbar">
        <label>
          教学楼
          <select
            value={building}
            onChange={(e) => setBuilding(e.target.value)}
          >
            {[
              "一教",
              "二教",
              "三教",
              "四教",
              "理教",
              "文史",
              "哲学",
              "地学",
              "国关",
              "政管",
            ].map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>
        </label>
        <label>
          日期
          <select value={day} onChange={(e) => setDay(e.target.value)}>
            <option value="today">今天</option>
            <option value="tomorrow">明天</option>
            <option value="day-after">后天</option>
          </select>
        </label>
        <label>
          筛选空闲节次
          <select
            value={slot}
            onChange={(e) => setSlot(Number(e.target.value))}
          >
            <option value={0}>全部教室</option>
            {Array.from({ length: 12 }, (_, i) => (
              <option key={i} value={i + 1}>
                第 {i + 1} 节空闲
              </option>
            ))}
          </select>
        </label>
      </div>
      <Resource
        title={`${building} · 空闲教室`}
        q={q}
        login={login}
        extra={
          <span className="room-legend">
            <i />
            空闲 <i className="occupied" />
            占用
          </span>
        }
      >
        {(data) => {
          const rows = data.filter((r) => !slot || !r.occupied[slot - 1]);
          return rows.length ? (
            <div className="table-scroll">
              <table className="room-table">
                <thead>
                  <tr>
                    <th>教室</th>
                    <th>座位</th>
                    {Array.from({ length: 12 }, (_, i) => (
                      <th key={i}>{i + 1}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.room}>
                      <td>
                        <strong>{r.room}</strong>
                      </td>
                      <td className="subtle">{r.capacity}</td>
                      {r.occupied.map((o, i) => (
                        <td key={i}>
                          <span
                            className={`room-slot ${o ? "occupied" : ""}`}
                            title={`第 ${i + 1} 节${o ? "占用" : "空闲"}`}
                            aria-label={`第 ${i + 1} 节${o ? "占用" : "空闲"}`}
                          >
                            {o ? "×" : "✓"}
                          </span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty icon={<MapPin />}>
              {slot ? "该节次没有空闲教室" : "没有教室信息"}
            </Empty>
          );
        }}
      </Resource>
    </>
  );
}
