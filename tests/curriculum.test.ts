import { describe, expect, it } from "vitest";
import {
  computeProgress,
  defaultVersion,
  inferProfile,
  normalizeCourseName,
  scoreStatus,
  sectionChoices,
  variantBase,
  type Plan,
  type PlanIndexEntry,
} from "../src/lib/curriculum";
import type { GradeCourse } from "../src/lib/grades";

const plan: Plan = {
  id: "2025-信息科学技术学院-智能科学与技术",
  cohort: 2025,
  volume: "北京大学本科培养方案（2025）理科卷",
  school: "信息科学技术学院",
  major: "智能科学与技术",
  track: null,
  title: "智能科学与技术专业",
  kind: "major",
  degree: "理学学士",
  totalCredits: { min: 140, max: 140 },
  topRequirements: [
    { id: "1", name: "公共基础课程", min: 45, max: 51, unit: "学分" },
    { id: "2", name: "专业必修课程", min: 55, max: 55, unit: "学分" },
    { id: "3", name: "选修课程", min: 34, max: 34, unit: "学分" },
  ],
  requirements: [
    {
      id: "1-1",
      parent: "1",
      name: "大学英语",
      requirement: "2～8 学分",
      min: 2,
      max: 8,
      unit: "学分",
    },
    {
      id: "1-2",
      parent: "1",
      name: "思想政治理论必修课",
      requirement: "19 学分",
      min: 19,
      max: 19,
      unit: "学分",
    },
    {
      id: "1-5",
      parent: "1",
      name: "信息课程",
      requirement: "6 学分",
      min: 6,
      max: 6,
      unit: "学分",
    },
    {
      id: "1-7",
      parent: "1",
      name: "体育课",
      requirement: "4 学分",
      min: 4,
      max: 4,
      unit: "学分",
    },
    {
      id: "1-8",
      parent: "1",
      name: "通识教育课",
      requirement: "12 学分",
      min: 12,
      max: 12,
      unit: "学分",
    },
    {
      id: "2-1",
      parent: "2",
      name: "专业基础课",
      requirement: "19 学分",
      min: 19,
      max: 19,
      unit: "学分",
    },
    {
      id: "2-2",
      parent: "2",
      name: "专业核心课",
      requirement: "32 学分",
      min: 32,
      max: 32,
      unit: "学分",
    },
    {
      id: "3-1",
      parent: "3",
      name: "专业选修课",
      requirement: "20 学分",
      min: 20,
      max: 20,
      unit: "学分",
    },
    {
      id: "3-2",
      parent: "3",
      name: "自主选修课",
      requirement: "14 学分",
      min: 14,
      max: 14,
      unit: "学分",
    },
  ],
  groups: [
    {
      id: "1.1",
      parent: "1",
      name: "公共必修课",
      courses: [course("04830041", "计算概论 A", "全校必修", 3)],
      alternatives: [],
    },
    {
      id: "2.1",
      parent: "2",
      name: "专业基础课",
      min: 19,
      courses: [
        course("00132511", "高等数学 A（一）", "专业必修", 5),
        course("00132611", "线性代数 A（Ⅰ）", "专业必修", 4),
      ],
      alternatives: [
        {
          code: "00132301",
          name: "数学分析（Ⅰ）",
          credits: 5,
          replaces: "高等数学 A（一）",
        },
      ],
    },
    {
      id: "2.2",
      parent: "2",
      name: "专业核心课",
      min: 32,
      courses: [course("04834040", "人工智能引论", "专业必修", 3)],
      alternatives: [],
    },
    {
      id: "3.1-1",
      parent: "3.1",
      kind: "list",
      name: "专业数学类",
      min: 3,
      courses: [course("04835310", "离散数学基础", "任选", 3)],
      alternatives: [],
    },
  ],
  notes: [],
  warnings: [],
  source: { volumeId: "2025-理科", url: "", lineStart: 1, lineEnd: 2 },
};
function course(code: string, name: string, nature: string, credits: number) {
  return {
    code,
    name,
    nature,
    credits,
    hours: null,
    practice: null,
    term: null,
  };
}
const score = (
  kcmc: string,
  xf: string,
  xqcj: string,
  kclbmc: string,
  xnd = "25-26",
  xq = "1",
): GradeCourse => ({ kcmc, xf, xqcj, kclbmc, xnd, xq });

describe("normalizeCourseName", () => {
  it("unifies width, spaces, roman and chinese numerals", () => {
    expect(normalizeCourseName("高等数学 A（一）")).toBe(
      normalizeCourseName("高等数学A(Ⅰ)"),
    );
    expect(normalizeCourseName("线性代数 A（Ⅰ）")).toBe("线性代数a(1)");
    expect(variantBase(normalizeCourseName("计算概论 A（实验班）"))).toBe(
      "计算概论a",
    );
  });
  it("classifies score strings without guessing", () => {
    expect(scoreStatus("85")).toBe("passed");
    expect(scoreStatus("59.5")).toBe("failed");
    expect(scoreStatus("合格")).toBe("passed");
    expect(scoreStatus("W")).toBe("withdrawn");
    expect(scoreStatus("")).toBe("inProgress");
    expect(scoreStatus("EX")).toBe("passed");
    expect(scoreStatus("待定")).toBe("other");
  });
});

describe("computeProgress", () => {
  const scores = [
    score("高等数学 A（一）", "5", "92", "专业必修"),
    score("数学分析（Ⅱ）", "5", "88", "专业必修"),
    score("计算概论 A（实验班）", "3", "95", "全校必修"),
    score("中国近现代史纲要", "3", "81", "全校必修"),
    score("游泳", "1", "95.5", "全校必修"),
    score("听觉文化与世界文明", "2", "96", "通选课"),
    score("人工智能引论", "3", "W", "专业必修"),
    score("量子计算", "3", "", "专业必修", "26-27", "1"),
    score("大学英语（三）", "2", "P", "全校必修"),
  ];
  const courses = [
    {
      id: "a",
      name: "线性代数 A（Ⅰ）",
      semester: "26-27学年第1学期",
      current: true,
    },
    {
      id: "b",
      name: "离散数学基础",
      semester: "26-27学年第1学期",
      current: true,
    },
    {
      id: "c",
      name: "高等数学 A（一）",
      semester: "25-26学年第1学期",
      current: false,
    },
  ];
  it("assigns by name, alternative, variant, keyword and category, and leaves the rest pending", () => {
    const progress = computeProgress(plan, scores, courses);
    const find = (id: string) =>
      progress.sections
        .flatMap((s) => [s, ...s.children])
        .find((s) => s.id === id)!;
    expect(find("2-1").earned).toBe(5);
    expect(find("2-1").inProgress).toBe(4);
    expect(find("1-5").earned).toBe(3);
    expect(find("1-5").courses[0].via).toBe("variant");
    expect(find("1-2").earned).toBe(3);
    expect(find("1-7").earned).toBe(1);
    expect(find("1-1").earned).toBe(2);
    expect(find("1-8").earned).toBe(2);
    expect(find("1").earned).toBe(3 + 3 + 1 + 2 + 2);
    expect(find("3-1").inProgress).toBe(3);
    expect(progress.pending.map((p) => p.name)).toEqual([
      "数学分析（Ⅱ）",
      "量子计算",
    ]);
    expect(progress.ignored.map((p) => p.name)).toEqual(["人工智能引论"]);
    expect(progress.totals).toMatchObject({
      required: 140,
      earned: 16,
      inProgress: 7,
      unknownCredits: 0,
    });
    expect(find("2").children.map((c) => c.id)).toEqual(["2-1", "2-2"]);
  });
  it("honours user overrides including ignore", () => {
    const progress = computeProgress(plan, scores, courses, {
      [normalizeCourseName("数学分析（Ⅱ）")]: "2-1",
      [normalizeCourseName("量子计算")]: "ignore",
    });
    const base = progress.sections
      .find((s) => s.id === "2")!
      .children.find((c) => c.id === "2-1")!;
    expect(base.earned).toBe(10);
    expect(base.courses.find((c) => c.name === "数学分析（Ⅱ）")?.via).toBe(
      "override",
    );
    expect(progress.pending).toEqual([]);
    expect(progress.ignored.map((c) => c.name)).toContain("量子计算");
    expect(sectionChoices(progress).map((c) => c.id)).toContain("3-2");
  });
  it("fixes English credits by level and adds the shortfall to general education", () => {
    const progress = computeProgress(
      plan,
      scores,
      courses,
      {},
      { englishLevel: "B" },
    );
    const pub = progress.sections.find((s) => s.id === "1")!;
    const english = pub.children.find((c) => c.id === "1-1")!;
    const general = pub.children.find((c) => c.id === "1-8")!;
    expect(english).toMatchObject({
      min: 6,
      max: 6,
      requirement: "6 学分（B 级）",
    });
    expect(general).toMatchObject({ min: 14, max: 14 });
    expect(general.note).toMatch(/专业或通识选修/);
    expect(pub).toMatchObject({ min: 51, max: 51 });
    const full = computeProgress(
      plan,
      scores,
      courses,
      {},
      { englishLevel: "Y" },
    );
    expect(
      full.sections
        .find((s) => s.id === "1")!
        .children.find((c) => c.id === "1-8")!.min,
    ).toBe(12);
    const untouched = computeProgress(plan, scores, courses);
    expect(
      untouched.sections
        .find((s) => s.id === "1")!
        .children.find((c) => c.id === "1-1"),
    ).toMatchObject({ min: 2, max: 8 });
  });
  it("falls back to course groups when a plan has no requirement table", () => {
    const bare: Plan = { ...plan, requirements: [], topRequirements: [] };
    const progress = computeProgress(bare, scores, courses);
    expect(progress.usesRequirements).toBe(false);
    expect(progress.sections.map((s) => s.id)).toEqual([
      "1.1",
      "2.1",
      "2.2",
      "3.1-1",
    ]);
    expect(progress.sections.find((s) => s.id === "2.1")!.earned).toBe(5);
  });
});

describe("inferProfile", () => {
  const index: PlanIndexEntry[] = [
    {
      id: "2025-x-智能",
      cohort: 2025,
      school: "信科",
      major: "智能",
      track: null,
      title: "智能科学与技术专业",
      kind: "major",
      degree: null,
      totalCredits: null,
      volume: "",
      file: "2025/a.json",
      courses: 1,
      warnings: 0,
      core: ["高等数学 A（一）", "人工智能引论", "线性代数 A（Ⅰ）"],
    },
    {
      id: "2025-x-计算机",
      cohort: 2025,
      school: "信科",
      major: "计算机",
      track: null,
      title: "计算机科学与技术专业",
      kind: "major",
      degree: null,
      totalCredits: null,
      volume: "",
      file: "2025/b.json",
      courses: 1,
      warnings: 0,
      core: ["高等数学 A（一）", "计算机系统导论"],
    },
    {
      id: "2023-x-智能",
      cohort: 2023,
      school: "信科",
      major: "智能",
      track: null,
      title: "智能科学与技术专业",
      kind: "major",
      degree: null,
      totalCredits: null,
      volume: "",
      file: "2023/a.json",
      courses: 1,
      warnings: 0,
      core: ["高等数学 A（一）", "人工智能引论"],
    },
    {
      id: "2025-x-项目",
      cohort: 2025,
      school: "信科",
      major: "项目",
      track: null,
      title: "某项目",
      kind: "project",
      degree: null,
      totalCredits: null,
      volume: "",
      file: "2025/c.json",
      courses: 1,
      warnings: 0,
      core: ["高等数学 A（一）", "人工智能引论", "线性代数 A（Ⅰ）"],
    },
  ];
  it("takes the earliest term as the cohort and ranks plans of that version by core overlap", () => {
    const result = inferProfile(
      [
        score("高等数学 A（一）", "5", "92", "专业必修", "25-26", "1"),
        score("人工智能引论", "3", "88", "专业必修", "25-26", "2"),
      ],
      [
        {
          id: "a",
          name: "线性代数 A（Ⅰ）",
          semester: "26-27学年第1学期",
          current: true,
        },
      ],
      index,
    );
    expect(result.cohort).toBe(2025);
    expect(result.version).toBe(2025);
    expect(result.candidates[0]).toMatchObject({
      id: "2025-x-智能",
      matched: 3,
    });
    expect(result.candidates.some((c) => c.id === "2025-x-项目")).toBe(false);
    expect(result.evidence[0]).toContain("2025 级");
  });
  it("maps cohorts without a volume to the nearest earlier version", () => {
    expect(defaultVersion(2022)).toBe(2021);
    expect(defaultVersion(2019)).toBe(2021);
    expect(defaultVersion(null)).toBe(2025);
    const result = inferProfile(
      [score("高等数学 A（一）", "5", "92", "专业必修", "22-23", "1")],
      [],
      index,
    );
    expect(result.version).toBe(2021);
    expect(result.evidence).toContain("没有 2022 版培养方案，默认使用 2021 版");
  });
  it("says so when nothing overlaps", () => {
    const result = inferProfile([], [], index);
    expect(result.cohort).toBeNull();
    expect(result.candidates).toEqual([]);
    expect(result.evidence[0]).toContain("手动选择");
  });
});
