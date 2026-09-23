import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Curriculum from "../src/pages/Curriculum";
import { planIndex, type CurrentCourse } from "../src/lib/curriculum";

const ai = planIndex.find(
  (p) => p.cohort === 2025 && p.title === "智能科学与技术专业",
)!;
const envelope = (data: unknown) => ({
  data,
  error: null,
  warnings: [],
  stale: false,
  generation: "test",
  updatedAt: new Date().toISOString(),
});
const scores = {
  courses: [
    {
      kcmc: "高等数学 A（一）",
      xf: "5",
      xqcj: "92",
      kclbmc: "专业必修",
      xnd: "25-26",
      xq: "1",
    },
    {
      kcmc: "人工智能引论",
      xf: "3",
      xqcj: "88",
      kclbmc: "专业必修",
      xnd: "25-26",
      xq: "2",
    },
    {
      kcmc: "人工智能中的数学",
      xf: "4",
      xqcj: "85",
      kclbmc: "专业必修",
      xnd: "25-26",
      xq: "2",
    },
    {
      kcmc: "听觉文化与世界文明",
      xf: "2",
      xqcj: "96",
      kclbmc: "通选课",
      xnd: "25-26",
      xq: "3",
    },
    {
      kcmc: "神秘学导论",
      xf: "2",
      xqcj: "90",
      kclbmc: "专业必修",
      xnd: "25-26",
      xq: "2",
    },
  ],
  semester_gpas: [],
  overall_gpa: "",
  total_credits: "12",
};

function mount(
  profile: unknown,
  currentCourses: CurrentCourse[] = [
    {
      id: "c1",
      name: "线性代数 A（Ⅰ）",
      semester: "26-27学年第1学期",
      current: true,
    },
  ],
) {
  const calls: Array<Record<string, unknown>> = [];
  let stored = profile;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      const data =
        body.kind === "profile"
          ? stored
          : body.kind === "setProfile"
            ? ((stored = body.profile), stored)
            : body.kind === "scores"
              ? scores
              : body.kind === "allCourses"
                ? currentCourses
                : body.kind === "openLink"
                  ? { opened: true }
                  : null;
      return { ok: true, json: async () => envelope(data) };
    }),
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <Curriculum login={() => {}} navigate={() => {}} />
    </QueryClientProvider>,
  );
  return calls;
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("infers cohort and major for a new user, lets them change it, and saves the profile", async () => {
  const calls = mount(null);
  expect(await screen.findByText("先确认年级与专业")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByLabelText("专业")).toHaveValue(ai.id));
  expect(screen.getByLabelText("入学年份")).toHaveValue("2025");
  expect(
    screen.getByText(/与“智能科学与技术专业”的专业必修课重合/),
  ).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("院系"), {
    target: { value: "数学科学学院" },
  });
  expect(screen.getByLabelText("专业")).not.toHaveValue(ai.id);
  fireEvent.change(screen.getByLabelText("院系"), {
    target: { value: "信息科学技术学院" },
  });
  fireEvent.change(screen.getByLabelText("专业"), { target: { value: ai.id } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() =>
    expect(calls.some((c) => c.kind === "setProfile")).toBe(true),
  );
  const saved = calls.find((c) => c.kind === "setProfile")!.profile as Record<
    string,
    unknown
  >;
  expect(saved).toMatchObject({ cohort: 2025, planId: ai.id, inferred: false });
  expect(
    await screen.findByLabelText(`主修方案：${ai.title}`),
  ).toBeInTheDocument();
});

it("shows earned, in-progress and pending courses and persists a manual assignment", async () => {
  const calls = mount({
    cohort: 2025,
    planId: ai.id,
    secondaryPlanId: null,
    englishLevel: null,
    overrides: {},
    inferred: true,
    updatedAt: "x",
  });
  const section = await screen.findByLabelText(`主修方案：${ai.title}`);
  expect(section).toBeInTheDocument();
  // 高数 5 + 人工智能引论 3 + 人工智能中的数学 4 + 通选 2 = 14 已获；线代 4 在修；神秘学导论待确认。
  expect(await screen.findByText("待确认（1）")).toBeInTheDocument();
  const total = screen.getByRole("tab", { name: /毕业总学分/ });
  expect(within(total).getByText("14")).toBeInTheDocument();
  expect(within(total).getByText("/ 140")).toBeInTheDocument();
  expect(total).toHaveTextContent("在修 4 · 还差 122");
  const major = screen.getByRole("tab", { name: /专业必修课程/ });
  expect(within(major).getByText("12")).toBeInTheDocument();
  fireEvent.click(major);
  expect(
    screen.getByRole("tabpanel", { name: "专业必修课程明细" }),
  ).toHaveTextContent("专业基础课");
  expect(
    screen.getByRole("button", { name: "原文 PDF · 书页 446–453" }),
  ).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("归类 神秘学导论"), {
    target: { value: "2-2" },
  });
  await waitFor(() =>
    expect(calls.some((c) => c.kind === "setProfile")).toBe(true),
  );
  const saved = calls.find((c) => c.kind === "setProfile")!.profile as {
    overrides: Record<string, string>;
  };
  expect(saved.overrides).toEqual({ 神秘学导论: "2-2" });
  await waitFor(() =>
    expect(screen.queryByText("待确认（1）")).not.toBeInTheDocument(),
  );
  expect(
    within(screen.getByRole("tab", { name: /毕业总学分/ })).getByText("16"),
  ).toBeInTheDocument();
});

it("fixes the English requirement by level and moves the shortfall into general education", async () => {
  mount({
    cohort: 2025,
    planId: ai.id,
    secondaryPlanId: null,
    englishLevel: "C",
    overrides: {},
    inferred: true,
    updatedAt: "x",
  });
  await screen.findByLabelText(`主修方案：${ai.title}`);
  fireEvent.click(screen.getByRole("tab", { name: /公共基础课程/ }));
  const panel = screen.getByRole("tabpanel", { name: "公共基础课程明细" });
  expect(panel).toHaveTextContent("4 学分（C 级）");
  expect(panel).toHaveTextContent("16 学分（含补齐大学英语 4 学分）");
  expect(screen.queryByText(/选择你的英语分级/)).not.toBeInTheDocument();
});

it("offers to pick a plan when the profile was saved without one", async () => {
  mount({
    cohort: 2024,
    planId: null,
    secondaryPlanId: null,
    overrides: {},
    inferred: false,
    updatedAt: "x",
  });
  expect(await screen.findByText(/尚未选择培养方案/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "选择年级与专业" }));
  expect(
    await screen.findByText("修改年级与专业", { selector: "h2" }),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("入学年份")).toHaveValue("2024");
  expect(screen.getByLabelText("培养方案版本")).toHaveValue("2024");
});

it("names unknown-credit courses and separately labels pending courses without credits", async () => {
  mount(
    {
      cohort: 2025,
      planId: ai.id,
      secondaryPlanId: null,
      englishLevel: null,
      overrides: {},
      inferred: false,
      updatedAt: "x",
    },
    [
      { id: "sport", name: "太极拳", current: true },
      { id: "unknown", name: "待确认测试课程", current: true },
    ],
  );
  const warning = await screen.findByText(/已归类课程中有 1 门课的学分未知/);
  expect(warning).toHaveTextContent("太极拳");
  expect(warning).not.toHaveTextContent("待确认测试课程");
  expect(warning).toHaveTextContent("教学网在修课程列表不提供学分");
  expect(
    screen.getByLabelText("归类 待确认测试课程").closest("li"),
  ).toHaveTextContent("学分未知");
  fireEvent.change(screen.getByLabelText("归类 待确认测试课程"), {
    target: { value: "3-2" },
  });
  const updated = await screen.findByText(/已归类课程中有 2 门课的学分未知/);
  expect(updated).toHaveTextContent("太极拳、待确认测试课程");
  expect(screen.getByRole("tab", { name: /毕业总学分/ })).toHaveTextContent(
    "在修 0",
  );
});
