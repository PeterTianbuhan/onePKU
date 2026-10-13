import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Courses from "../src/pages/Courses";
import { NotificationProvider } from "../src/lib/notifications";
import Assignments from "../src/pages/Assignments";
import { pageLink } from "../src/lib/navigation";

function mount(
  node: React.ReactNode,
  data: Record<string, unknown>,
  options: { notifications?: boolean } = {},
) {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => {
      const request = JSON.parse(options.body);
      requests.push(request.kind);
      return {
        ok: true,
        json: async () => ({
          data: data[request.kind] ?? [],
          error: null,
          warnings: [],
          stale: false,
          generation: "test",
          updatedAt: new Date().toISOString(),
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
      {options.notifications ? (
        <NotificationProvider>{node}</NotificationProvider>
      ) : (
        node
      )}
    </QueryClientProvider>,
  );
  return requests;
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});

it("opens a course as a page focused on replay and returns to the filtered course list", async () => {
  history.replaceState(null, "", `/#${encodeURIComponent("课程")}`);
  const requests = mount(
    <Courses login={() => {}} />,
    {
      allCourses: [
        { id: "a", name: "历史课程", current: false, semester: "旧学期" },
      ],
      videos: [],
      haoxueStatus: { connected: true },
    },
    { notifications: true },
  );
  fireEvent.change(screen.getByPlaceholderText("搜索课程"), {
    target: { value: "历史" },
  });
  fireEvent.click(await screen.findByRole("button", { name: /历史课程/ }));
  await screen.findByRole("heading", { level: 1, name: "历史课程" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  // 与安卓端一致：课程详情默认落在课程通知，回放要点过去。
  expect(
    screen.getByRole("button", { name: "作业", exact: true }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "课堂实录" }),
  ).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "课程回放", exact: true }),
  );
  expect(
    screen.getByRole("button", { name: "课程回放", exact: true }),
  ).toHaveClass("active");
  expect(requests).toContain("videos");
  expect(requests).not.toContain("content");
  expect(requests).not.toContain("recordings");
  fireEvent.click(screen.getByRole("button", { name: "课程", exact: true }));
  expect(await screen.findByPlaceholderText("搜索课程")).toHaveValue("历史");
  expect(screen.getByRole("region", { name: "旧学期" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "历史课程" })).toBeInTheDocument();
});

it("opens an assignment deep link as a page and returns to its course list without starting a submission", async () => {
  history.replaceState(
    null,
    "",
    `/#${encodeURIComponent(pageLink("作业", { course: "old", assignment: "lab" }))}`,
  );
  const requests = mount(<Assignments login={() => {}} />, {
    allCourses: [
      { id: "old", name: "历史课", current: false, semester: "旧学期" },
    ],
    courseAssignments: [
      {
        hash_id: "lab",
        course_id: "old",
        content_id: "content",
        title: "实验作业",
        course_name: "历史课",
        deadline: null,
        deadline_raw: null,
        last_attempt: null,
        detail_error: false,
        descriptions: ["阅读说明后完成练习"],
        attachments: [],
      },
    ],
  });
  await screen.findByRole("heading", { level: 1, name: "实验作业" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("combobox", { name: "作业课程" }),
  ).not.toBeInTheDocument();
  expect(screen.getByText("阅读说明后完成练习")).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "作业列表", exact: true }),
  );
  expect(await screen.findByRole("combobox", { name: "作业课程" })).toHaveValue(
    "old",
  );
  expect(
    await screen.findByRole("button", { name: /实验作业/ }),
  ).toBeInTheDocument();
  expect(
    requests.every((kind) =>
      ["allCourses", "courseAssignments", "assignmentFeedback"].includes(kind),
    ),
  ).toBe(true);
});
