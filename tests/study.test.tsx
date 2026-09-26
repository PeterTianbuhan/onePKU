import React from "react";
import { afterEach, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Courses from "../src/pages/Courses";
import CardStats from "../src/components/CardStats";
import { resetService } from "../src/lib/api";
const envelope = (data: unknown) => ({
  data,
  error: null,
  warnings: [],
  updatedAt: new Date().toISOString(),
  generation: "test",
  stale: false,
});
function mount(node: React.ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      {node}
    </QueryClientProvider>,
  );
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("groups every semester newest first and searches across semesters", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () =>
        envelope([
          {
            id: "_1",
            name: "当前课程",
            current: true,
            semester: "26-27学年第1学期",
          },
          {
            id: "_2",
            name: "历史课程",
            current: false,
            semester: "25-26学年第2学期",
          },
        ]),
    })),
  );
  mount(<Courses login={() => {}} />);
  await screen.findByRole("heading", { name: "当前课程" });
  expect(
    screen.queryByRole("combobox", { name: "课程学期" }),
  ).not.toBeInTheDocument();
  const current = screen.getByRole("region", { name: "26-27学年第1学期" });
  const previous = screen.getByRole("region", { name: "25-26学年第2学期" });
  expect(
    within(current).getByRole("heading", { name: "当前课程" }),
  ).toBeInTheDocument();
  expect(
    within(previous).getByRole("heading", { name: "历史课程" }),
  ).toBeInTheDocument();
  expect(
    current.compareDocumentPosition(previous) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  fireEvent.change(screen.getByPlaceholderText("搜索课程"), {
    target: { value: "历史" },
  });
  expect(screen.getByRole("heading", { name: "历史课程" })).toBeInTheDocument();
  expect(
    screen.queryByRole("region", { name: "26-27学年第1学期" }),
  ).not.toBeInTheDocument();
});
it("keeps monthly totals readable when categories fail and requests the selected month", async () => {
  const fetch = vi.fn(async (_u, o) => {
    const r = JSON.parse(o.body);
    return {
      ok: true,
      json: async () =>
        r.part === "category"
          ? {
              ...envelope(null),
              error: { code: "network", message: "分类暂不可用" },
            }
          : envelope(
              r.part === "total"
                ? { income: 0, expenses: 1234 }
                : r.part === "consumption"
                  ? { amount: 1000 }
                  : {},
            ),
    };
  });
  vi.stubGlobal("fetch", fetch);
  mount(
    <CardStats
      login={() => {}}
      card={<div>余额</div>}
      transactions={<div>近期交易</div>}
    />,
  );
  expect(await screen.findByText("¥12.34")).toBeInTheDocument();
  expect(await screen.findByText("¥10.00")).toBeInTheDocument();
  expect(screen.getByText("全部转出")).toBeInTheDocument();
  expect(screen.getByText("近期交易")).toBeInTheDocument();
  expect(
    fetch.mock.calls.some(([, o]) => JSON.parse(o.body).part === "category"),
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "消费统计" }));
  expect(await screen.findByText("分类暂不可用")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("统计月份"), {
    target: { value: "2025-02" },
  });
  await waitFor(() =>
    expect(
      fetch.mock.calls.filter(
        ([, o]) => JSON.parse(o.body).month === "2025-02",
      ),
    ).toHaveLength(4),
  );
});
it("clears private study and card resources on their account change", async () => {
  const client = new QueryClient();
  for (const kind of ["allCourses", "videos", "scores", "exams", "cardStats"]) {
    client.setQueryData(["resource", { kind }], envelope("private"));
  }
  resetService(client, "treehole");
  await waitFor(() =>
    expect(
      client.getQueryData(["resource", { kind: "scores" }]),
    ).toBeUndefined(),
  );
  expect(client.getQueryData(["resource", { kind: "exams" }])).toBeUndefined();
  expect(
    client.getQueryData(["resource", { kind: "allCourses" }]),
  ).toBeDefined();
  resetService(client, "course");
  resetService(client, "campuscard");
  await waitFor(() =>
    expect(
      client.getQueryData(["resource", { kind: "cardStats" }]),
    ).toBeUndefined(),
  );
  expect(client.getQueryData(["resource", { kind: "videos" }])).toBeUndefined();
});
