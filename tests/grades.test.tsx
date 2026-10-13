import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Grades from "../src/pages/Grades";
import {
  calculateGrades,
  countsAsMajor,
  emptyScopeOverride,
  inScope,
  isMajorRequired,
  normalizeScope,
  officialGpa,
  scopeKeyOf,
  toggleScope,
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
  // 与安卓端一致：成绩按学期分组列出，组头带这学期的 GPA 与平均分。
  const term = screen.getByRole("region", { name: "25-26 学年第2学期" });
  expect(term).toHaveTextContent("GPA 3.25");
  expect(term).toHaveTextContent("平均 80.00");
  expect(screen.getByText("42")).toBeInTheDocument();
  expect(screen.getByText("甲")).toBeInTheDocument();
  expect(term).toHaveTextContent("乙");
  expect(term).not.toHaveTextContent("甲");
});
it("prefers official GPA at each scope without replacing the locally calculated average", async () => {
  mount("3.60", "0");
  expect(await screen.findByText("3.60")).toBeInTheDocument();
  expect(screen.queryByText("按官方规则计算")).not.toBeInTheDocument();
  expect(screen.getByText("85.00")).toBeInTheDocument();
  // 每学期优先用学校给的 GPA（这里是 0，是真值不是占位）。
  expect(
    screen.getByRole("region", { name: "25-26 学年第2学期" }),
  ).toHaveTextContent("GPA 0.00");
  expect(
    screen.getByRole("region", { name: "25-26 学年第2学期" }),
  ).toHaveTextContent("平均 80.00");
});

const row = (
  kcmc: string,
  kclbmc: string,
  xqcj = "90",
  xf = "3",
  xnd = "25-26",
  xq = "1",
): GradeCourse => ({ kcmc, kclbmc, xqcj, xf, xnd, xq });

it("recognizes the major scope by course category", () => {
  expect(isMajorRequired(row("编译", "专业必修"))).toBe(true);
  expect(isMajorRequired(row("算法", "专业限选"))).toBe(true);
  expect(isMajorRequired(row("体育", "必修"))).toBe(false);
  expect(scopeKeyOf(row("编译", "专业必修"))).toBe("25-26-1|编译");
});

it("applies manual scope adjustments the way the Android client does", () => {
  const mislabeled = row("离散数学", "任选");
  const required = row("编译原理", "专业必修");
  // 类别标错的课手动加进来；本来就计入的课不需要覆盖，取消才写排除。
  const added = toggleScope(emptyScopeOverride, mislabeled, true);
  expect(added.included).toEqual(["25-26-1|离散数学"]);
  expect(added.excluded).toEqual([]);
  const removed = toggleScope(emptyScopeOverride, required, false);
  expect(removed.included).toEqual([]);
  expect(removed.excluded).toEqual(["25-26-1|编译原理"]);
  expect(countsAsMajor(mislabeled, added)).toBe(true);
  expect(inScope(mislabeled, "major", added)).toBe(true);
  expect(countsAsMajor(required, removed)).toBe(false);
  // 再点一次恢复自动口径：手动项被清掉。
  const back = toggleScope(added, mislabeled, false);
  expect(back).toEqual(emptyScopeOverride);
  // 本来就计入的课勾掉再勾回，不留下多余的手动纳入。
  expect(toggleScope(removed, required, true).excluded).toEqual([]);
});

it("computes the major scope separately from all courses", () => {
  const courses = [
    row("编译原理", "专业必修", "90", "4"),
    row("毛概", "必修", "60", "2"),
    row("离散数学", "任选", "100", "2"),
  ];
  const all = calculateGrades(courses);
  const major = calculateGrades(courses, "major");
  expect(all.included).toBe(3);
  expect(major.included).toBe(1);
  expect(major.credits).toBe(4);
  expect(major.gpa).toBeCloseTo(3.8125, 4);
  // 全部课程口径不受口径调整影响，专业口径才看手动项。
  expect(
    calculateGrades(
      courses,
      "all",
      toggleScope(emptyScopeOverride, courses[2], true),
    ).included,
  ).toBe(3);
  expect(
    calculateGrades(
      courses,
      "major",
      toggleScope(emptyScopeOverride, courses[2], true),
    ).included,
  ).toBe(2);
});

it("ignores malformed stored scope adjustments", () => {
  expect(normalizeScope(null)).toEqual(emptyScopeOverride);
  expect(normalizeScope({ included: "x" })).toEqual(emptyScopeOverride);
  expect(normalizeScope({ included: ["a", 1, null], excluded: ["b"] })).toEqual(
    {
      included: ["a"],
      excluded: ["b"],
    },
  );
});
