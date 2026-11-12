import { useResource, type Assignment, type Notice } from "./api";
import { legacyNoticeKey, noticeKey, useNotifications } from "./notifications";

export type CourseStatus = { due: number; unread: number };

/** 待交：没有提交记录，而且还没过截止时间（没有截止时间也算）。 */
export function isPending(a: Assignment, now = Date.now()) {
  return !a.last_attempt && (!a.deadline || Date.parse(a.deadline) >= now);
}

/**
 * 每门课现在有几项作业待交、几条通知没读。
 * 侧栏和课程页的选项卡都用它，只读本学期的汇总列表，不逐门课发请求。
 */
export function useCourseStatus(): Map<string, CourseStatus> {
  const assignments = useResource<Assignment[]>({ kind: "assignments" });
  const notices = useResource<Notice[]>({ kind: "notices" });
  const news = useNotifications();
  const status = new Map<string, CourseStatus>();
  const at = (course: string) => {
    if (!status.has(course)) status.set(course, { due: 0, unread: 0 });
    return status.get(course)!;
  };
  const now = Date.now();
  for (const a of assignments.data?.data ?? [])
    if (isPending(a, now)) at(a.course_id).due += 1;
  const generation = notices.data?.generation ?? "";
  for (const n of notices.data?.data ?? []) {
    if (!n.course_id) continue;
    const read = [
      noticeKey(n, generation),
      legacyNoticeKey(n, generation),
    ].some(news.isRead);
    if (!read) at(n.course_id).unread += 1;
  }
  return status;
}
