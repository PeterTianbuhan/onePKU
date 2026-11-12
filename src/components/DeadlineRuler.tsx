import type { Assignment } from "../lib/api";
import { fmtTime } from "../lib/api";
import { pageLink } from "../lib/navigation";
import CourseGlyph from "./CourseGlyph";

const DAY = 24 * 60 * 60 * 1000;
const SPAN = 14;
const beijingDay = (time: number) =>
  new Date(time).toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });

/**
 * 两周的时间尺：一天一格，没交的作业按截止日立在尺上，用课程的颜色。
 * 只画今天起十四天内的；过期的和更远的在下面的清单里。
 */
export default function DeadlineRuler({
  assignments,
  now,
  navigate,
}: {
  assignments: Assignment[];
  now: number;
  navigate: (page: string) => void;
}) {
  // 以北京时间今天的正午为锚，逐日加 24 小时，避开本机时区。
  const noon = Date.parse(`${beijingDay(now)}T12:00:00+08:00`);
  const due = new Map<string, Assignment[]>();
  for (const a of assignments) {
    if (a.last_attempt || !a.deadline || Date.parse(a.deadline) < now) continue;
    const key = beijingDay(Date.parse(a.deadline));
    due.set(key, [...(due.get(key) ?? []), a]);
  }
  return (
    <ol className="ruler" aria-label="未来两周的截止日">
      {Array.from({ length: SPAN }, (_, i) => {
        const time = noon + i * DAY;
        const key = beijingDay(time);
        const date = Number(key.slice(8));
        const weekday = new Date(time).toLocaleDateString("zh-CN", {
          timeZone: "Asia/Shanghai",
          weekday: "narrow",
        });
        const items = due.get(key) ?? [];
        return (
          <li
            key={key}
            className={[
              i === 0 && "today",
              "六日".includes(weekday) && "rest",
              items.length > 0 && "marked",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <div className="ruler-marks">
              {items.slice(0, 3).map((a) => (
                <button
                  key={a.hash_id}
                  title={`${a.title} · ${a.course_name} · ${fmtTime(a.deadline!)}`}
                  aria-label={`${a.course_name}：${a.title}，${fmtTime(a.deadline!)} 截止`}
                  onClick={() =>
                    navigate(pageLink("作业", { assignment: a.hash_id }))
                  }
                >
                  <CourseGlyph name={a.course_name} />
                </button>
              ))}
              {items.length > 3 && <small>+{items.length - 3}</small>}
            </div>
            <time dateTime={key}>
              <small>{i === 0 ? "今" : weekday}</small>
              <b>
                {date === 1 && i > 0 ? `${Number(key.slice(5, 7))}/1` : date}
              </b>
            </time>
          </li>
        );
      })}
    </ol>
  );
}
