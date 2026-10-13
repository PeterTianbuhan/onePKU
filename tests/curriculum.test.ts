import { describe, expect, it } from "vitest";
import {
  computeProgress,
  defaultVersion,
  inferProfile,
  normalizeCourseName,
  scoreStatus,
  sectionChoices,
  variantBase,
  directionSplits,
  directionsFor,
  type Plan,
  type PlanGroup,
  type PlanIndexEntry,
  type Progress,
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
  it("follows the Android rule: the site's current flag decides 在修", () => {
    const rows = [
      {
        id: "flagged",
        name: "线性代数 A（Ⅰ）",
        semester: "26-27学年第1学期",
        current: true,
      },
      // 学校把还在上的课挂在「非当前学期课程」分组里也照样算在修，与安卓端一致。
      {
        id: "late",
        name: "习近平新时代中国特色社会主义思想概论",
        semester: "25-26学年第2学期",
        current: true,
      },
      {
        id: "labeled",
        name: "离散数学基础",
        semester: "26-27学年第1学期",
        current: false,
      },
      {
        id: "exercise",
        name: "线性代数 A（Ⅰ）习题课",
        semester: "26-27学年第1学期",
        current: true,
      },
    ];
    const doing = computeProgress(plan, [], rows)
      .sections.flatMap((s) => [s, ...s.children])
      .flatMap((s) => s.courses)
      .filter((c) => c.status === "inProgress")
      .map((c) => c.name);
    expect(doing).toContain("线性代数 A（Ⅰ）");
    expect(doing).toContain("习近平新时代中国特色社会主义思想概论");
    // 没被列进「当前」分组的课不再靠学期标签去猜。
    expect(doing).not.toContain("离散数学基础");
    // 习题课不算独立一门课：教学网把它和正课并排列进来，算上就是重复计数。
    expect(doing).not.toContain("线性代数 A（Ⅰ）习题课");
  });
  it("keeps a current course visible when the transcript can't count it", () => {
    // 学校有时把还在上的课先登进成绩单（免修/状态异常）。这条记录不该把
    // 教学网「当前学期课程」里的同一门课挡掉。
    const name = "习近平新时代中国特色社会主义思想概论";
    const progress = computeProgress(
      plan,
      [score(name, "3", "免修", "思想政治理论课")],
      [{ id: "current", name, current: true }],
    );
    const listed = [
      ...progress.sections
        .flatMap((s) => [s, ...s.children])
        .flatMap((s) => s.courses)
        .filter((c) => c.status === "inProgress")
        .map((c) => c.name),
      ...progress.pending.map((c) => c.name),
    ];
    expect(listed).toContain(name);
  });
  it("assigns by name, alternative, variant, keyword and category, and leaves the rest pending", () => {
    const progress = computeProgress(plan, scores, courses);
    const find = (id: string) =>
      progress.sections
        .flatMap((s) => [s, ...s.children])
        .find((s) => s.id === id)!;
    expect(find("2-1").earned).toBe(5);
    // 在修课程的学分不由方案回填：教学网列表里根本没有学分那一列。
    expect(find("2-1").inProgress).toBe(0);
    expect(find("1-5").earned).toBe(3);
    expect(find("1-5").courses[0].via).toBe("variant");
    expect(find("1-2").earned).toBe(3);
    expect(find("1-7").earned).toBe(1);
    expect(find("1-1").earned).toBe(2);
    expect(find("1-8").earned).toBe(2);
    expect(find("1").earned).toBe(3 + 3 + 1 + 2 + 2);
    expect(find("3-1").inProgress).toBe(0);
    expect(progress.pending.map((p) => p.name)).toEqual([
      "数学分析（Ⅱ）",
      "量子计算",
    ]);
    expect(progress.ignored.map((p) => p.name)).toEqual(["人工智能引论"]);
    expect(progress.totals).toMatchObject({
      required: 140,
      earned: 16,
      inProgress: 0,
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
  it("lets a manual assignment win outright without taking credits from the plan", () => {
    for (const name of [
      "高等数学 A（一）",
      "数学分析（Ⅰ）",
      "计算概论 A（实验班）",
    ]) {
      const overrides = { [normalizeCourseName(name)]: "3-2" };
      const progress = computeProgress(
        plan,
        [],
        [{ id: "current", name, current: true }],
        overrides,
      );
      const assigned = progress.sections
        .flatMap((s) => s.children)
        .find((s) => s.id === "3-2")!;
      expect(assigned.courses[0]).toMatchObject({
        credits: null,
        via: "override",
        sectionId: "3-2",
      });
      expect(progress.totals.inProgress).toBe(0);
      expect(progress.totals.unknownCredits).toBe(0);
      const graded = computeProgress(
        plan,
        [score(name, "2", "P", "任选")],
        [],
        overrides,
      );
      expect(graded.totals.earned).toBe(2);
      // 成绩单没给学分时也不回填方案学分，改由手填那条路补。
      const missing = computeProgress(
        plan,
        [score(name, "", "P", "任选")],
        [],
        overrides,
      );
      expect(missing.totals.earned).toBe(0);
      expect(missing.totals.unknownCredits).toBe(1);
      const ignored = computeProgress(
        plan,
        [],
        [{ id: "current", name, current: true }],
        { [normalizeCourseName(name)]: "ignore" },
      );
      expect(ignored.totals.inProgress).toBe(0);
      expect(ignored.ignored[0].credits).toBeNull();
    }
  });
  it("lets a manually entered credit count win over the score and the plan", () => {
    const name = "高等数学 A（一）";
    const key = normalizeCourseName(name);
    const graded = computeProgress(
      plan,
      [score(name, "5", "92", "专业必修")],
      [],
      {},
      { manualCredits: { [key]: 3 } },
    );
    expect(graded.totals.earned).toBe(3);
    // 0 学分课是真实存在的：手填 0 就必须按 0 计，不能当成没填。
    const zero = computeProgress(
      plan,
      [score(name, "5", "92", "专业必修")],
      [],
      {},
      { manualCredits: { [key]: 0 } },
    );
    expect(zero.totals.earned).toBe(0);
    // 在修课程没有学分来源，手填后才计入。
    const filled = computeProgress(
      plan,
      [],
      [{ id: "c", name, current: true }],
      {},
      { manualCredits: { [key]: 4 } },
    );
    expect(filled.totals.inProgress).toBe(4);
    expect(filled.totals.unknownCredits).toBe(0);
  });
  it("does not count an exercise course alongside its main course", () => {
    const progress = computeProgress(
      plan,
      [],
      [
        { id: "main", name: "线性代数 A（Ⅰ）", current: true },
        { id: "exercise", name: "线性代数 A（Ⅰ）习题", current: true },
      ],
    );
    const rows = progress.sections
      .flatMap((s) => [s, ...s.children])
      .flatMap((s) => s.courses)
      .filter((c) => c.status === "inProgress");
    // 教学网把习题课和正课并排列进在修，算两遍就是重复计数。
    expect(rows.map((c) => c.name)).toEqual(["线性代数 A（Ⅰ）"]);
  });
  it("does not invent credits from a public-course keyword or a manual category", () => {
    const courses = [
      { id: "sport", name: "太极拳", current: true },
      { id: "unknown", name: "待确认测试课程", current: true },
    ];
    const progress = computeProgress(plan, [], courses);
    // 在修没填学分只是列出，不算成「缺学分」。
    expect(progress.totals).toMatchObject({ inProgress: 0, unknownCredits: 0 });
    expect(progress.pending[0]).toMatchObject({
      name: "待确认测试课程",
      credits: null,
    });
    const manual = computeProgress(plan, [], courses, {
      待确认测试课程: "3-2",
    });
    expect(manual.totals).toMatchObject({ inProgress: 0, unknownCredits: 0 });
    expect(manual.pending).toEqual([]);
  });
  it("fixes the English series by level without touching general education", () => {
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
    // 差额不再补进通识教育课，大类总额改为按各子系列求和。
    expect(general).toMatchObject({ min: 12, max: 12 });
    expect(general.note ?? "").not.toMatch("英语差额");
    expect(pub).toMatchObject({ min: 47, max: 47 });
    const full = computeProgress(
      plan,
      scores,
      courses,
      {},
      { englishLevel: "Y" },
    );
    const fullTop = full.sections.find((s) => s.id === "1")!;
    expect(fullTop.children.find((c) => c.id === "1-1")!.min).toBe(8);
    expect(fullTop.min).toBe(49);
    const untouched = computeProgress(plan, scores, courses);
    expect(
      untouched.sections
        .find((s) => s.id === "1")!
        .children.find((c) => c.id === "1-1"),
    ).toMatchObject({ min: 2, max: 8 });
  });
  it("folds the level into 公共必修课 when English is not a series of its own", () => {
    const folded: Plan = {
      ...structuredClone(plan),
      requirements: plan.requirements.map((r) =>
        r.id === "1-1" ? { ...r, name: "公共必修课（含外语）" } : r,
      ),
    };
    const progress = computeProgress(
      folded,
      [],
      [],
      {},
      {
        englishLevel: "C",
      },
    );
    const series = progress.sections
      .find((s) => s.id === "1")!
      .children.find((c) => c.id === "1-1")!;
    // 弹性 2～8 折在公共必修课里：下限 2 +（C 级 4 - 2）= 4。
    expect(series.min).toBe(4);
    expect(series.max).toBe(4);
    expect(series.note).toContain("大学英语计入本类");
  });
  it("leaves English credits alone for English majors and international students", () => {
    const englishMajor: Plan = {
      ...structuredClone(plan),
      major: "英语",
      school: "外国语学院",
    };
    const progress = computeProgress(
      englishMajor,
      [],
      [],
      {},
      {
        englishLevel: "B",
      },
    );
    expect(
      progress.sections
        .find((s) => s.id === "1")!
        .children.find((c) => c.id === "1-1"),
    ).toMatchObject({ min: 2, max: 8 });
    const international: Plan = {
      ...structuredClone(plan),
      title: "留学生预科理科培养方案",
    };
    expect(
      computeProgress(international, [], [], {}, { englishLevel: "B" })
        .sections.find((s) => s.id === "1")!
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

describe("plan totals follow the plan's own arithmetic", () => {
  const makePlan = (over: Partial<Plan> = {}): Plan => ({
    id: "2025-测试学院-测试专业",
    cohort: 2025,
    volume: "v",
    school: "测试学院",
    major: "测试专业",
    track: null,
    title: "t",
    kind: "major",
    degree: null,
    totalCredits: { min: 130, max: 160 },
    topRequirements: [
      { id: "1", name: "公共基础课程", min: 45, max: 51, unit: "学分" },
      { id: "2", name: "专业必修课程", min: 55, max: 55, unit: "学分" },
      { id: "3", name: "选修课程", min: 40, max: 40, unit: "学分" },
    ],
    requirements: [
      {
        id: "1-1",
        parent: "1",
        name: "思想政治理论必修课",
        requirement: "19 学分",
        min: 19,
        max: 19,
        unit: "学分",
      },
      { id: "1-2", parent: "1", name: "英语", requirement: "", unit: "学分" },
      {
        id: "2-9",
        parent: "2",
        name: "专业核心课",
        requirement: "30 学分",
        min: 30,
        max: 30,
        unit: "学分",
      },
      {
        id: "3-1",
        parent: "3",
        name: "自主选修课",
        requirement: "40 学分",
        min: 40,
        max: 40,
        unit: "学分",
      },
    ],
    groups: [],
    notes: [],
    warnings: [],
    source: { volumeId: "2025-测试", url: "", lineStart: 1, lineEnd: 2 },
    ...over,
  });
  const leaf = (progress: Progress, id: string) => {
    for (const top of progress.sections) {
      if (top.id === id) return top;
      const hit = top.children.find((child) => child.id === id);
      if (hit) return hit;
    }
    return null;
  };
  it("derives the only missing sub-series from the parent total", () => {
    const progress = computeProgress(makePlan(), [], []);
    // 大类一是 45～51 学分，其余子系列 19 学分，差额 26，上限 51-19=32。
    expect(leaf(progress, "1-2")?.min).toBe(26);
    expect(leaf(progress, "1-2")?.max).toBe(32);
    expect(leaf(progress, "1-2")?.requirement).toBe("26～32 学分");
    expect(leaf(progress, "1-2")?.note).toContain("扣除其余子系列推得");
  });
  it("does not invent a total when two or more sub-series are missing", () => {
    const progress = computeProgress(
      makePlan({
        requirements: [
          ...makePlan().requirements,
          {
            id: "1-3",
            parent: "1",
            name: "体育课",
            requirement: "",
            unit: "学分",
          },
        ],
      }),
      [],
      [],
    );
    expect(leaf(progress, "1-2")?.min).toBeUndefined();
    expect(leaf(progress, "1-3")?.min).toBeUndefined();
  });
  it("restores a sub-series that only appears among course groups, in numeric id order", () => {
    const progress = computeProgress(
      makePlan({
        groups: [
          {
            id: "2.2",
            parent: "2",
            name: "专业选修课",
            min: 12,
            max: 12,
            unit: "学分",
            note: "只在课程组里出现",
            courses: [course("04834041", "人工智能伦理", "任选", 2)],
            alternatives: [],
          },
        ],
      }),
      [],
      [],
    );
    expect(
      progress.sections.find((s) => s.id === "2")?.children.map((c) => c.id),
    ).toEqual(["2-2", "2-9"]);
    expect(leaf(progress, "2-2")?.min).toBe(12);
    expect(leaf(progress, "2-2")?.note).toBe("只在课程组里出现");
  });
  it("takes a top-level total from the plan groups when the requirement table omits it", () => {
    const progress = computeProgress(
      makePlan({
        topRequirements: makePlan().topRequirements.filter((t) => t.id !== "2"),
        groups: [
          {
            id: "2",
            parent: null,
            name: "专业必修课程",
            min: 55,
            max: 55,
            unit: "学分",
            courses: [],
            alternatives: [],
          },
        ],
      }),
      [],
      [],
    );
    expect(progress.sections.find((s) => s.id === "2")?.min).toBe(55);
  });
  it("accepts a summed graduation total only inside the plan's own range", () => {
    // 三个大类合计 140，方案自述 130～160，因此采用合计而不是下限。
    expect(computeProgress(makePlan(), [], []).totals.required).toBe(140);
    const stated = makePlan({ totalCredits: { min: 150, max: 160 } });
    expect(computeProgress(stated, [], []).totals.required).toBe(150);
    const hours = makePlan({
      topRequirements: [
        { id: "1", name: "公共基础课程", min: 45, max: 51, unit: "学分" },
        { id: "2", name: "专业必修课程", min: 55, max: 55, unit: "学分" },
        { id: "3", name: "选修课程", min: 40, max: 40, unit: "学时" },
      ],
    });
    expect(computeProgress(hours, [], []).totals.required).toBe(130);
    const unknown = makePlan({
      topRequirements: makePlan().topRequirements.filter((t) => t.id !== "3"),
      requirements: makePlan().requirements.filter((r) => r.id !== "3-1"),
    });
    expect(computeProgress(unknown, [], []).totals.required).toBe(130);
  });
  describe("direction splits", () => {
    const groups: PlanGroup[] = [
      {
        id: "2",
        parent: null,
        name: "专业必修课程",
        min: 18,
        max: 24,
        unit: "学分",
        courses: [],
        alternatives: [],
      },
      {
        id: "2.1",
        parent: "2",
        name: "专业核心课",
        courses: [],
        alternatives: [],
      },
      {
        id: "2.1-1",
        parent: "2.1",
        name: "理论方向",
        min: 18,
        max: 18,
        unit: "学分",
        courses: [course("a1", "量子力学", "专业必修", 3)],
        alternatives: [],
      },
      {
        id: "2.1-2",
        parent: "2.1",
        name: "应用方向",
        min: 20,
        max: 20,
        unit: "学分",
        courses: [course("a2", "半导体物理", "专业必修", 4)],
        alternatives: [],
      },
    ];
    const requirements = [
      {
        id: "1-1",
        parent: "1",
        name: "思想政治理论必修课",
        requirement: "19 学分",
        min: 19,
        max: 19,
        unit: "学分",
      },
      {
        id: "1-2",
        parent: "1",
        name: "英语",
        requirement: "8 学分",
        min: 8,
        max: 8,
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
        requirement: "20 学分",
        min: 20,
        max: 20,
        unit: "学分",
      },
    ];
    const splitPlan = makePlan({
      totalCredits: { min: 80, max: 120 },
      groups,
      requirements,
      topRequirements: [
        { id: "1", name: "公共基础课程", min: 27, max: 27, unit: "学分" },
        { id: "3", name: "选修课程", min: 40, max: 40, unit: "学分" },
      ],
    });
    const rows = [
      score("量子力学", "3", "90", "专业必修"),
      score("半导体物理", "4", "88", "专业必修"),
    ];
    it("lists a direction group only when the parent itself has no total", () => {
      const splits = directionSplits(splitPlan);
      expect(splits).toHaveLength(1);
      expect(splits[0]).toMatchObject({
        sectionId: "2-1",
        name: "专业核心课",
        options: [
          { groupId: "2.1-1", name: "理论方向", min: 18 },
          { groupId: "2.1-2", name: "应用方向", min: 20 },
        ],
      });
      // 父类自己给了总额的，是模块清单而不是互斥方向。
      expect(
        directionSplits(
          makePlan({
            groups: groups.map((g) => (g.id === "2.1" ? { ...g, min: 18 } : g)),
            requirements,
            topRequirements: splitPlan.topRequirements,
          }),
        ),
      ).toEqual([]);
    });
    it("mixes every direction's courses while no direction is chosen", () => {
      const progress = computeProgress(splitPlan, rows, []);
      const core = progress.sections
        .find((s) => s.id === "2")!
        .children.find((c) => c.id === "2-1")!;
      // 子系列唯一的缺口由大类总额推得，课还来不及分方向。
      expect(core.min).toBe(18);
      expect(core.max).toBe(24);
      expect(core.note).toContain("推得");
      expect(core.courses.map((c) => c.name)).toEqual([
        "量子力学",
        "半导体物理",
      ]);
    });
    it("counts only the chosen direction and re-sums the parent total", () => {
      const progress = computeProgress(
        splitPlan,
        rows,
        [],
        {},
        {
          directions: { "2-1": "2.1-2" },
        },
      );
      const major = progress.sections.find((s) => s.id === "2")!;
      const core = major.children.find((c) => c.id === "2-1")!;
      expect(core.min).toBe(20);
      expect(core.requirement).toBe("20 学分");
      expect(core.note).toContain("已选方向「应用方向」");
      expect(core.courses.map((c) => c.name)).toEqual(["半导体物理"]);
      // 另一个方向独有的课不再算进这一类，落到待确认里。
      expect(progress.pending.map((c) => c.name)).toEqual(["量子力学"]);
      expect(major.min).toBe(20);
      expect(major.requirement).toBe("20 学分");
      expect(progress.totals.required).toBe(87);
    });
    it("reads only the current plan's direction choices", () => {
      expect(
        directionsFor("2025-a-b", {
          "2025-a-b|2-1": "2.1-2",
          "2025-c-d|1-1": "1.1",
        }),
      ).toEqual({ "2-1": "2.1-2" });
    });
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
    expect(result.narrowedBySchool).toBeNull();
  });
  describe("department narrowing", () => {
    const entry = (over: Partial<PlanIndexEntry>): PlanIndexEntry => ({
      id: "id",
      cohort: 2025,
      school: "信科",
      major: "m",
      track: null,
      title: "t",
      kind: "major",
      degree: null,
      totalCredits: null,
      volume: "",
      file: "f.json",
      courses: 1,
      warnings: 0,
      core: [],
      ...over,
    });
    const plans: PlanIndexEntry[] = [
      entry({
        id: "2025-w-物理",
        school: "物理学院",
        title: "物理学专业",
        core: ["力学", "热学"],
      }),
      entry({
        id: "2025-w-数学",
        school: "数学科学学院",
        title: "数学专业",
        core: ["力学", "热学", "量子力学"],
      }),
    ];
    const taken = [
      score("力学", "5", "90", "专业必修", "25-26", "1"),
      score("热学", "4", "88", "专业必修", "25-26", "1"),
      score("量子力学", "3", "91", "专业必修", "25-26", "2"),
    ];
    it("keeps candidates inside the department registered at the portal", () => {
      const result = inferProfile(taken, [], plans, "物理学院");
      expect(result.narrowedBySchool).toBe("物理学院");
      expect(result.candidates.map((c) => c.id)).toEqual(["2025-w-物理"]);
      expect(
        result.evidence.some((line) => line.includes("限定候选范围")),
      ).toBe(true);
    });
    it("matches the same school written differently", () => {
      expect(inferProfile(taken, [], plans, "数学科学").narrowedBySchool).toBe(
        "数学科学学院",
      );
      expect(inferProfile(taken, [], plans, "物理").narrowedBySchool).toBe(
        "物理学院",
      );
    });
    it("falls back to the whole school when the department has no overlap", () => {
      const chemistry = entry({
        id: "2025-w-化学",
        school: "化学与分子工程学院",
        title: "化学专业",
        core: ["无机化学"],
      });
      const result = inferProfile(
        taken,
        [],
        [...plans, chemistry],
        "化学与分子工程学院",
      );
      expect(result.narrowedBySchool).toBe("化学与分子工程学院");
      expect(result.candidates.length).toBeGreaterThan(0);
      expect(
        result.evidence.some((line) => line.includes("改按全校方案排序")),
      ).toBe(true);
    });
    it("ranks across the whole school when no department is chosen", () => {
      const result = inferProfile(taken, [], plans);
      expect(result.narrowedBySchool).toBeNull();
      expect(result.candidates[0].id).toBe("2025-w-数学");
    });
  });
});
