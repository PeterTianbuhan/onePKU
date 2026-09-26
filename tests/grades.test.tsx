import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Grades from "../src/pages/Grades";
import {
  calculateGrades,
  officialGpa,
  type GradeCourse,
} from "../src/lib/grades";

const course = (
  score: string,
  credit = "1",
  name = "课程",
  term = "1",
): GradeCourse => ({
  kcmc: name,
  xf: credit,
  xqcj: score,
  kclbmc: "必修",
  xnd: "25-26",
  xq: term,
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("uses the continuous PKU formula, including decimal scores and credit weights", () => {
  const result = calculateGrades([course("95.5", "1"), course("80", "3")]);
  expect(result.gpa).toBeCloseTo(3.4280078125, 10);
  expect(result.average).toBe(83.875);
  expect(result.credits).toBe(4);
});
it("includes zero, failures, and every retake rather than taking the best grade", () => {
  const result = calculateGrades([
    course("0"),
    course("59"),
    course("60"),
    course("100"),
  ]);
  expect(result.gpa).toBe(1.25);
  expect(result.average).toBe(54.75);
  expect(result.included).toBe(4);
});
it("excludes non-percentage statuses and explicit thesis or comprehensive exam records", () => {
  const rows = ["合格", "不合格", "EX", "I", "IP", "P", "NP", "W", "A", ""].map(
    (s) => course(s),
  );
  rows.push(course("100", "5", "毕业论文"), course("90", "2", "综合性考试"));
  const result = calculateGrades([...rows, course("80", "3")]);
  expect(result).toMatchObject({
    gpa: 3.25,
    average: 80,
    credits: 3,
    included: 1,
    excluded: 12,
  });
});
it("does not treat blank, malformed, or invalid score and credit data as zero", () => {
  const rows = [" ", "101", "-1", "90分", "NaN", "Infinity", "0x50"].map((s) =>
    course(s),
  );
  rows.push(...["", "0", "-2", "NaN"].map((c) => course("90", c)));
  expect(calculateGrades(rows)).toMatchObject({
    gpa: null,
    average: null,
    included: 0,
  });
  expect(calculateGrades([]).gpa).toBeNull();
});
it("accepts a genuine official zero and rejects missing or out-of-range GPA", () => {
  expect(officialGpa("0")).toBe(0);
  expect(officialGpa("3.456")).toBe(3.456);
  for (const value of [undefined, "", " ", "N/A", "5", "-1"])
    expect(officialGpa(value)).toBeNull();
});
function mount(overall = "", termGpa = "") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: {
          courses: [
            course("100", "1", "甲", "1"),
            course("80", "3", "乙", "2"),
            course("W", "5", "丙", "2"),
          ],
          semester_gpas: termGpa ? [{ xndxq: "25-26-2", gpa: termGpa }] : [],
          overall_gpa: overall,
          total_credits: "42",
        },
        error: null,
        warnings: [],
        updatedAt: new Date().toISOString(),
        generation: "test",
        stale: false,
      }),
    })),
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Grades login={() => {}} />
    </QueryClientProvider>,
  );
}
it("fills missing GPA and average, updates both for the semester, and keeps official earned credits", async () => {
  mount();
  expect(await screen.findByText("3.44")).toBeInTheDocument();
  expect(screen.getByText("85.00")).toBeInTheDocument();
  expect(screen.getByText("按官方规则计算")).toBeInTheDocument();
  expect(
    screen.getByLabelText("成绩计算说明").parentElement,
  ).not.toHaveAttribute("open");
  fireEvent.change(screen.getByLabelText("成绩学期"), {
    target: { value: "25-26-2" },
  });
  expect(screen.getByText("学期 GPA")).toBeInTheDocument();
  expect(screen.getByText("3.25")).toBeInTheDocument();
  expect(screen.getByText("80.00")).toBeInTheDocument();
  expect(screen.getByText("42")).toBeInTheDocument();
  expect(screen.queryByText("甲")).not.toBeInTheDocument();
});
it("prefers official GPA at each scope without replacing the locally calculated average", async () => {
  mount("3.60", "0");
  expect(await screen.findByText("3.60")).toBeInTheDocument();
  expect(screen.queryByText("按官方规则计算")).not.toBeInTheDocument();
  expect(screen.getByText("85.00")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("成绩学期"), {
    target: { value: "25-26-2" },
  });
  expect(screen.getByText("0.00")).toBeInTheDocument();
  expect(screen.getByText("80.00")).toBeInTheDocument();
});

it("separates professional-course GPA from school GPA and persists explicit scope changes", async () => {
  let overrides = { included: [] as string[], excluded: [] as string[] };
  const rows = [
    { ...course("100", "1", "专业课"), kclbmc: "专业必修" },
    { ...course("80", "3", "任选专业课"), kclbmc: "任选" },
  ];
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u, o) => {
      const request = JSON.parse(o.body);
      requests.push(request);
      if (request.kind === "setGradeScope")
        overrides = { included: request.included, excluded: request.excluded };
      return {
        ok: true,
        json: async () => ({
          data:
            request.kind === "scores"
              ? {
                  courses: rows,
                  semester_gpas: [],
                  overall_gpa: "3.60",
                  total_credits: "42",
                }
              : overrides,
          error: null,
          warnings: [],
          stale: false,
          generation: "account-A",
          updatedAt: "2026-09-26",
        }),
      };
    }),
  );
  const client = new QueryClient();
  const renderGrades = () => (
    <QueryClientProvider client={client}>
      <Grades login={() => {}} />
    </QueryClientProvider>
  );
  const view = render(renderGrades());
  expect(await screen.findByText("3.60")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("成绩统计范围"), {
    target: { value: "major" },
  });
  expect(await screen.findByText("4.00")).toBeInTheDocument();
  expect(screen.queryByText("3.60")).not.toBeInTheDocument();
  expect(screen.queryByText("任选专业课")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "调整课程范围" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /任选专业课/ }));
  fireEvent.click(screen.getByRole("button", { name: "保存范围" }));
  expect(await screen.findByText("3.44")).toBeInTheDocument();
  expect(requests.find((r) => r.kind === "setGradeScope")?.generation).toBe(
    "account-A",
  );
  view.unmount();
  render(renderGrades());
  fireEvent.change(await screen.findByLabelText("成绩统计范围"), {
    target: { value: "major" },
  });
  expect(await screen.findByText("3.44")).toBeInTheDocument();
});

it("does not display default professional statistics when saved scope cannot be read", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u, o) => {
      const r = JSON.parse(o.body);
      return {
        ok: true,
        json: async () => ({
          data:
            r.kind === "scores"
              ? {
                  courses: [{ ...course("100"), kclbmc: "专业必修" }],
                  semester_gpas: [],
                  overall_gpa: "3.60",
                  total_credits: "1",
                }
              : null,
          error:
            r.kind === "gradeScope"
              ? { code: "auth", message: "账号已变化" }
              : null,
          warnings: [],
          generation: "A",
          stale: false,
          updatedAt: null,
        }),
      };
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Grades login={() => {}} />
    </QueryClientProvider>,
  );
  fireEvent.change(await screen.findByLabelText("成绩统计范围"), {
    target: { value: "major" },
  });
  expect(await screen.findByText("账号已变化")).toBeInTheDocument();
  expect(screen.queryByText("4.00")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "调整课程范围" })).toBeDisabled();
});
