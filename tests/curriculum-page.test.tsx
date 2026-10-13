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
import {
  IGNORE,
  normalizeCourseName,
  planIndex,
  type CurrentCourse,
} from "../src/lib/curriculum";

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
  // 高数 5 + 人工智能引论 3 + 人工智能中的数学 4 + 通选 2 = 14 已获；线代在修但不带学分；神秘学导论待确认。
  expect(await screen.findByText("待确认（1）")).toBeInTheDocument();
  const total = screen.getByRole("tab", { name: /毕业总学分/ });
  expect(within(total).getByText("14")).toBeInTheDocument();
  expect(within(total).getByText("/ 140")).toBeInTheDocument();
  expect(total).toHaveTextContent("在修 0 · 还差 126");
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

it("fixes the English requirement by level without inflating general education", async () => {
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
  // 英语差额不再补进通识教育课，通识仍按方案自己写的学分要求计。
  expect(panel).toHaveTextContent("通识教育课");
  expect(panel).toHaveTextContent("12 学分");
  expect(panel.textContent).not.toMatch("含补齐大学英语");
  expect(screen.queryByText(/选择你的英语分级/)).not.toBeInTheDocument();
});

it("edits an earned course's credits from its own row", async () => {
  const calls = mount({
    cohort: 2025,
    planId: ai.id,
    secondaryPlanId: null,
    englishLevel: null,
    overrides: {},
    directions: {},
    manualCredits: {},
    inferred: true,
    updatedAt: "x",
  });
  await screen.findByLabelText(`主修方案：${ai.title}`);
  fireEvent.click(screen.getByRole("tab", { name: /专业必修课程/ }));
  const panel = await screen.findByRole("tabpanel");
  // 当前类别直接摊开在修与已修，不需要再点「N 门课」。
  expect(
    within(panel).getAllByRole("button", { name: /收起/ }).length,
  ).toBeGreaterThan(0);
  expect(within(panel).getAllByText(/已修课程/).length).toBeGreaterThan(0);
  const input = await screen.findByLabelText("学分 高等数学 A（一）");
  fireEvent.change(input, { target: { value: "3" } });
  fireEvent.blur(input);
  const key = normalizeCourseName("高等数学 A（一）");
  await waitFor(() =>
    expect(
      calls.some(
        (c) =>
          c.kind === "setProfile" &&
          JSON.stringify(
            (c.profile as { manualCredits: unknown }).manualCredits,
          ) === JSON.stringify({ [key]: 3 }),
      ),
    ).toBe(true),
  );
  // 手填学分直接改合计：专业必修从 12 变成 10。
  await waitFor(() =>
    expect(screen.getByRole("tab", { name: /专业必修课程/ })).toHaveTextContent(
      "10",
    ),
  );
  // 已识别的课也能改归类；改成不计入后这一行就不再出现在系列里。
  fireEvent.change(screen.getByLabelText("归类 高等数学 A（一）"), {
    target: { value: IGNORE },
  });
  await waitFor(() =>
    expect(
      calls.some(
        (c) =>
          c.kind === "setProfile" &&
          (c.profile as { overrides: Record<string, string> }).overrides[
            key
          ] === IGNORE,
      ),
    ).toBe(true),
  );
  await waitFor(() =>
    expect(
      screen.queryByLabelText("学分 高等数学 A（一）"),
    ).not.toBeInTheDocument(),
  );
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

it("shows a course that belongs to a section which has sub-sections", async () => {
  // 2025 物理方案里习概归在「公共基础课程」这一类本身，不是它的子课目。
  // 以前父类只要有子课目就只渲染子课目，这门课在页面上没有任何地方出现。
  mount(
    {
      cohort: 2025,
      planId: "2025-物理学院-物理学",
      secondaryPlanId: null,
      englishLevel: null,
      overrides: {},
      inferred: false,
      updatedAt: "x",
    },
    [
      {
        id: "xg",
        name: "习近平新时代中国特色社会主义思想概论",
        semester: "26-27学年第1学期",
        current: true,
      },
    ],
  );
  const row = await screen.findByLabelText(
    "归类 习近平新时代中国特色社会主义思想概论",
  );
  expect(row.closest("li")).toHaveTextContent("在修");
});

it("lists in-progress courses without credits instead of counting them as unknown", async () => {
  const calls = mount(
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
  // 教学网的在修列表不含学分，缺学分不再算成「学分未知」，只在课目里列出。
  await screen.findByLabelText(`主修方案：${ai.title}`);
  // 在修课不该藏在折叠的系列里：默认视图（毕业总学分）就要能直接看到它。
  expect(screen.getByLabelText("归类 太极拳")).toBeInTheDocument();
  expect(screen.getByLabelText("归类 太极拳").closest("li")).toHaveTextContent(
    "在修",
  );
  expect(screen.queryByText(/已归类课程中有/)).not.toBeInTheDocument();
  expect(
    screen.getByLabelText("归类 待确认测试课程").closest("li"),
  ).toHaveTextContent("学分未知");
  // 待确认那一行也能直接填学分，填了才计入在修。
  const credit = screen.getByLabelText("学分 待确认测试课程");
  fireEvent.change(credit, { target: { value: "2" } });
  fireEvent.blur(credit);
  const key = normalizeCourseName("待确认测试课程");
  await waitFor(() =>
    expect(
      calls.some(
        (c) =>
          c.kind === "setProfile" &&
          JSON.stringify(
            (c.profile as { manualCredits: unknown }).manualCredits,
          ) === JSON.stringify({ [key]: 2 }),
      ),
    ).toBe(true),
  );
  fireEvent.change(screen.getByLabelText("归类 待确认测试课程"), {
    target: { value: "3-2" },
  });
  expect(screen.queryByText(/已归类课程中有/)).not.toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByRole("tab", { name: /毕业总学分/ })).toHaveTextContent(
      "在修 2",
    ),
  );
});
