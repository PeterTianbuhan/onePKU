import { PenLine } from "lucide-react";

const DAY = 24 * 60 * 60 * 1000;
const beijing = (time: number, options: Intl.DateTimeFormatOptions) =>
  new Date(time).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    ...options,
  });

/** 截止时间的缓急：没有截止、已过、一天之内、其它。 */
export function dueTone(deadline: string | null, now: number): string {
  if (!deadline) return "open";
  const due = Date.parse(deadline);
  return due < now ? "overdue" : due - now < DAY ? "urgent" : "";
}

/** 日期印：星期在上，日子在下。没有截止时间时只留一支笔。 */
export default function DueStamp({
  deadline,
  now,
}: {
  deadline: string | null;
  now: number;
}) {
  const due = deadline ? Date.parse(deadline) : null;
  return (
    <span className={`due-stamp ${dueTone(deadline, now)}`}>
      {due === null ? (
        <PenLine size={16} />
      ) : (
        <>
          <small>{beijing(due, { weekday: "short" })}</small>
          <b>{beijing(due, { day: "numeric" }).replace("日", "")}</b>
        </>
      )}
    </span>
  );
}
