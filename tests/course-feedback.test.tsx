import React from "react";
import { afterEach, it, expect, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import CourseNotices from "../src/components/CourseNotices";
import AssignmentFeedback from "../src/components/AssignmentFeedback";
import {
  NotificationProvider,
  useNotifications,
  noticeKey,
} from "../src/lib/notifications";
import type { Assignment, Notice } from "../src/lib/api";
const notice: Notice = {
  course_id: "course-a",
  course_name: "课程 A",
  announcement: {
    id: "ann-a",
    title: "课程微信群",
    body: "",
    date: "2026年9月8日",
    author: "教师",
    url: "https://course.pku.edu.cn/webapps/blackboard/execute/announcement?course_id=course-a#ann-a",
  },
};
function State() {
  const n = useNotifications();
  return <p>{n.unread} 条未读</p>;
}
function mount(node: React.ReactNode, data: Record<string, unknown>) {
  const requests: Record<string, string>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u, o) => {
      const r = JSON.parse(o.body);
      requests.push(r);
      return {
        ok: true,
        json: async () => ({
          data: data[r.kind] ?? [],
          error: null,
          stale: false,
          warnings: [],
          generation: "test",
          updatedAt: null,
        }),
      };
    }),
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {node}
    </QueryClientProvider>,
  );
  return requests;
}
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("opens the exact course announcement original and shares read state with the global feed", async () => {
  localStorage.setItem("onepku.news.sources.v1", '["course"]');
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  mount(
    <NotificationProvider>
      <State />
      <CourseNotices course="course-a" login={() => {}} />
    </NotificationProvider>,
    { notices: [notice], courseNotices: [notice] },
  );
  await screen.findByText("1 条未读");
  fireEvent.click(await screen.findByRole("button", { name: /课程微信群/ }));
  // 与安卓端一致：先在应用内读正文，原文窗口要再点一次。
  expect(open).not.toHaveBeenCalled();
  await screen.findByText(
    "这条通知的正文未提取到，请打开教学网查看图片或附件。",
  );
  await screen.findByText("0 条未读");
  fireEvent.click(screen.getByRole("button", { name: "在原文窗口打开" }));
  expect(open).toHaveBeenCalledWith(
    notice.announcement.url,
    "_blank",
    "noopener,noreferrer",
  );
  await waitFor(() =>
    expect(localStorage.getItem("onepku.news.read.v1")).toContain(
      noticeKey(notice, "test"),
    ),
  );
  expect(noticeKey({ ...notice, course_id: "course-b" }, "test")).not.toBe(
    noticeKey(notice, "test"),
  );
});
it("reads a course's notices even when the global course subscription is disabled", async () => {
  localStorage.setItem("onepku.news.sources.v1", "[]");
  const requests = mount(
    <NotificationProvider>
      <CourseNotices course="history-course" login={() => {}} />
    </NotificationProvider>,
    { courseNotices: [notice] },
  );
  await screen.findByRole("button", { name: /课程微信群/ });
  expect(requests).toEqual([
    { kind: "courseNotices", course: "history-course" },
  ]);
});
it("shows zero, pending grades and unavailable attempts without turning failures into no feedback", async () => {
  const a = {
    course_id: "course-a",
    content_id: "content-a",
    title: "实验作业",
  } as Assignment;
  const base = {
    pointsPossible: "100",
    feedback: null,
    files: [],
    feedbackLinks: [],
    url: "https://course.pku.edu.cn/webapps/assignment/uploadAssignment?mode=view",
    unavailable: false,
  };
  const requests = mount(
    <AssignmentFeedback assignment={a} login={() => {}} />,
    {
      assignmentFeedback: {
        attempts: [
          {
            ...base,
            id: "a",
            label: "尝试 3",
            score: "0",
            feedback: "请补充证明",
            files: [{ name: "answer.zip", downloadId: "registered-file" }],
          },
          { ...base, id: "b", label: "尝试 2", score: null },
          { ...base, id: "c", label: "尝试 1", score: null, unavailable: true },
        ],
      },
    },
  );
  await screen.findByText("0 / 100");
  expect(screen.getByText("请补充证明")).toBeInTheDocument();
  expect(screen.getByText("未评分")).toBeInTheDocument();
  expect(screen.getByText("未能读取")).toBeInTheDocument();
  expect(requests).toEqual([
    { kind: "assignmentFeedback", course: "course-a", content: "content-a" },
  ]);
});
