// 培养方案：读取 data/curriculum/ 的离线数据，把成绩与在修课程归入学分系列。
// 规则见 docs/CURRICULUM-DATA.md。匹配不上的课程进入“待确认”，不猜。
import indexJson from "../../data/curriculum/index.json";
import type { GradeCourse } from "./grades";

export type CreditRange = { min?: number; max?: number; unit?: string };
export type PlanCourse = {
  code: string;
  name: string;
  nature: string | null;
  credits: number | null;
  hours: number | null;
  practice: number | null;
  term: string | null;
};
export type PlanAlternative = {
  code: string;
  name: string;
  credits: number | null;
  replaces: string | null;
};
export type PlanGroup = CreditRange & {
  id: string;
  parent: string | null;
  kind?: "list";
  name: string;
  note?: string;
  requirement?: string;
  courses: PlanCourse[];
  alternatives: PlanAlternative[];
};
export type PlanRequirement = CreditRange & {
  id: string;
  parent: string;
  name: string;
  requirement: string;
  inferredParent?: boolean;
};
export type Plan = {
  id: string;
  cohort: number;
  volume: string;
  school: string | null;
  major: string;
  track: string | null;
  title: string;
  kind: "major" | "project";
  degree: string | null;
  totalCredits: { min: number; max: number; inferred?: boolean } | null;
  topRequirements: (CreditRange & { id: string; name: string })[];
  requirements: PlanRequirement[];
  groups: PlanGroup[];
  notes: string[];
  warnings: string[];
  unparsed?: { code: string; line: number; text: string }[];
  titleInference?: { from: number; title: string; overlap: number };
  source: {
    volumeId: string;
    url: string;
    lineStart: number;
    lineEnd: number;
    /** 所在的 PDF 页码范围（从 1 起），用于抽取原文。 */
    pageStart?: number;
    pageEnd?: number;
    /** 页脚印刷的书页号，与 PDF 页码有前置页偏移。 */
    pageLabels?: [number, number] | null;
  };
};

/** 大学英语分级与对应的公共必修学分（2025 版《北京大学大学英语课程培养方案》表 1；免修按同文件第 3 条获 2 学分）。 */
export const ENGLISH_LEVELS = [
  { id: "Y", label: "Y 级", credits: 8 },
  { id: "A", label: "A 级", credits: 8 },
  { id: "B", label: "B 级", credits: 6 },
  { id: "C", label: "C 级", credits: 4 },
  { id: "C+", label: "C+ 级", credits: 2 },
  { id: "exempt", label: "免修", credits: 2 },
] as const;
export type EnglishLevel = (typeof ENGLISH_LEVELS)[number]["id"];
export const ENGLISH_MIN_CREDITS = 2;
export const ENGLISH_MAX_CREDITS = 8;
export function englishLevelInfo(level: EnglishLevel | null | undefined) {
  return ENGLISH_LEVELS.find((l) => l.id === level) ?? null;
}
export type PlanIndexEntry = {
  id: string;
  cohort: number;
  school: string | null;
  major: string;
  track: string | null;
  title: string;
  kind: "major" | "project";
  degree: string | null;
  totalCredits: { min: number; max: number } | null;
  volume: string;
  file: string;
  courses: number;
  warnings: number;
  core: string[];
};

export const planIndex = (indexJson as { plans: PlanIndexEntry[] }).plans;
export const planIndexMeta = indexJson as {
  generatedAt: string;
  source: string;
};

const planModules = import.meta.glob<{ default: Plan }>(
  "../../data/curriculum/*/*.json",
);
export async function loadPlan(id: string): Promise<Plan> {
  const entry = planIndex.find((p) => p.id === id);
  if (!entry) throw new Error("找不到该培养方案");
  const key = Object.keys(planModules).find((k) =>
    k.endsWith(`/${entry.file}`),
  );
  if (!key) throw new Error("培养方案文件缺失");
  return (await planModules[key]()).default;
}

/** 可选的方案版本（年份），从新到旧。 */
export function planVersions(): number[] {
  return [...new Set(planIndex.map((p) => p.cohort))].sort((a, b) => b - a);
}
/** 入学年份对应的默认版本：不大于入学年份的最新版；没有则取最早版。 */
export function defaultVersion(cohort: number | null): number | null {
  const versions = planVersions();
  if (!versions.length) return null;
  if (cohort === null) return versions[0];
  return versions.find((v) => v <= cohort) ?? versions[versions.length - 1];
}

const ROMAN: Record<string, string> = {
  Ⅰ: "1",
  Ⅱ: "2",
  Ⅲ: "3",
  Ⅳ: "4",
  Ⅴ: "5",
  Ⅵ: "6",
  I: "1",
  II: "2",
  III: "3",
  IV: "4",
  V: "5",
  VI: "6",
};
const CN_NUM: Record<string, string> = {
  一: "1",
  二: "2",
  三: "3",
  四: "4",
  五: "5",
  六: "6",
  上: "1",
  下: "2",
};
/** 课程名规范化：全角转半角、去空格、括号内罗马/中文序号转数字、统一大小写。 */
export function normalizeCourseName(name: string): string {
  let s = name.normalize("NFKC").trim().toLowerCase();
  s = s.replace(/[（(]([^（）()]*)[）)]/g, (_, inner: string) => {
    const t = inner.trim();
    if (ROMAN[t.toUpperCase()]) return `(${ROMAN[t.toUpperCase()]})`;
    if (CN_NUM[t]) return `(${CN_NUM[t]})`;
    return `(${t})`;
  });
  s = s.replace(/[\s·・．.]/g, "");
  s = s.replace(/[“”"'‘’]/g, "");
  return s;
}
/** 去掉实验班、荣誉、班号等变体后缀，用于第二轮匹配。 */
export function variantBase(normalized: string): string {
  return normalized
    .replace(/\((实验班|荣誉|honor|荣誉课程|英文班|国际班|双语)\)/g, "")
    .replace(/\(\d+班\)/g, "")
    .replace(/(实验班|荣誉)$/g, "");
}

export type CurrentCourse = {
  id: string;
  name: string;
  semester?: string;
  current?: boolean;
};
export type Overrides = Record<string, string>;
export type CourseStatus =
  "passed" | "failed" | "inProgress" | "withdrawn" | "other";
export type MatchVia =
  "name" | "alternative" | "variant" | "keyword" | "category" | "override";
export type MatchedCourse = {
  key: string;
  name: string;
  credits: number | null;
  status: CourseStatus;
  term: string;
  category: string;
  score: string;
  via: MatchVia | null;
  sectionId: string | null;
};
export type ProgressSection = CreditRange & {
  id: string;
  name: string;
  requirement: string | null;
  earned: number;
  inProgress: number;
  passedCount: number;
  courses: MatchedCourse[];
  children: ProgressSection[];
  note?: string;
};
export type Progress = {
  plan: Plan;
  sections: ProgressSection[];
  pending: MatchedCourse[];
  ignored: MatchedCourse[];
  totals: {
    required: number | null;
    earned: number;
    inProgress: number;
    unknownCredits: number;
  };
  usesRequirements: boolean;
};

export const IGNORE = "ignore";

function decimal(value: string): number | null {
  const t = value.trim();
  return /^\d+(?:\.\d+)?$/.test(t) ? Number(t) : null;
}
export function scoreStatus(score: string): CourseStatus {
  const s = score.trim().toUpperCase();
  const n = decimal(s);
  if (n !== null) return n >= 60 ? "passed" : "failed";
  if (["合格", "P", "EX", "通过", "优秀", "良好", "中等", "及格"].includes(s))
    return "passed";
  if (/^[A-D][+-]?$/.test(s)) return "passed";
  if (["不合格", "NP", "F", "不及格"].includes(s)) return "failed";
  if (s === "W") return "withdrawn";
  if (s === "" || s === "IP" || s === "I" || s === "未公布")
    return "inProgress";
  return "other";
}

const PUBLIC_KEYWORDS: [RegExp, RegExp][] = [
  [/英语/, /英语|大学英语/],
  [
    /思想政治理论必修|思政必修|思想政治理论课/,
    /思想道德|马克思主义基本原理|毛泽东思想|习近平|近现代史纲要|形势与政策|思想政治/,
  ],
  [/选择性必修/, /党史|新中国史|改革开放史|社会主义发展史|四史/],
  [/劳动/, /劳动/],
  [/军事/, /军事/],
  [
    /体育/,
    /^体育|体育|游泳|健美|武术|太极|瑜伽|篮球|足球|排球|羽毛球|乒乓|网球|跆拳|击剑|体适能|舞蹈|攀岩|滑冰|棒垒|定向|素质拓展|健身|田径|龄球|高尔夫|桥牌|棋/,
  ],
  [
    /信息课程|计算机/,
    /计算概论|数据结构与算法|计算机实习|上机|问题求解|人工智能与计算思维/,
  ],
];

type SectionIndex = {
  byName: Map<
    string,
    { sectionId: string; credits: number | null; via: MatchVia }
  >;
  categoryTargets: {
    general: string | null;
    publicRoot: string | null;
    elective: string | null;
    free: string | null;
    major: string | null;
  };
  publicChildren: { section: ProgressSection; nameRe: RegExp }[];
  flat: Map<string, ProgressSection>;
};

function makeSection(
  id: string,
  name: string,
  range: CreditRange & { requirement?: string; note?: string },
): ProgressSection {
  return {
    id,
    name,
    requirement: range.requirement ?? null,
    min: range.min,
    max: range.max,
    unit: range.unit,
    earned: 0,
    inProgress: 0,
    passedCount: 0,
    courses: [],
    children: [],
    note: range.note,
  };
}

/** 分组 id「2.2」对应要求 id「2-2」；只补这一层，更深的模块组仍归到所属子系列。 */
const SECOND_LEVEL_GROUP = /^[123]\.\d+$/;
function fmtCredits(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
function sectionIdPart(part: string | undefined): number {
  if (part === undefined) return -1;
  const value = Number(part);
  return Number.isInteger(value) ? value : -1;
}
function compareSectionIds(a: string, b: string): number {
  const pa = a.split("-");
  const pb = b.split("-");
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const na = sectionIdPart(pa[i]);
    const nb = sectionIdPart(pb[i]);
    if (na !== nb) return na - nb;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
/** 方案只在父级给了总额、恰好一个子系列没写学分要求时，用差额推出该子系列的下限。 */
function deriveMissingTotals(parent: ProgressSection) {
  if (parent.min === undefined) return;
  const missing = parent.children.filter((child) => child.min === undefined);
  if (missing.length !== 1) return;
  const known = parent.children
    .filter((child) => child.min !== undefined)
    .reduce((sum, child) => sum + (child.min as number), 0);
  const rest = parent.min - known;
  if (rest <= 0) return;
  const target = missing[0];
  const rawCeiling = parent.max === undefined ? undefined : parent.max - known;
  const ceiling =
    rawCeiling !== undefined && rawCeiling >= rest ? rawCeiling : undefined;
  target.min = rest;
  target.max = ceiling ?? rest;
  target.requirement =
    ceiling !== undefined && ceiling > rest
      ? `${fmtCredits(rest)}～${fmtCredits(ceiling)} 学分`
      : `${fmtCredits(rest)} 学分`;
  target.note =
    `该类在方案中按方向或模块分列，未给出统一学分要求；此处由「${parent.name} ${fmtCredits(parent.min)} 学分` +
    "扣除其余子系列推得，选定方向后即按该方向计算";
}
/** 各大类都定死后，毕业总学分也按求和落一次；同样只在方案自述的区间内才采用。 */
function recomputeRequired(
  plan: Plan,
  sections: ProgressSection[],
): number | null {
  const stated = plan.totalCredits;
  if (!stated) return null;
  if (
    sections.some((s) => (s.unit ?? "学分") !== "学分") ||
    sections.some((s) => s.min === undefined)
  )
    return stated.min;
  const sum = sections.reduce((n, s) => n + (s.min as number), 0);
  return sum >= stated.min && sum <= stated.max ? sum : stated.min;
}
/** 方案 PDF 里的对齐空格会变成「应用物理学二（计算机交叉）   ：20 学分」。 */
function tidy(name: string): string {
  return name
    .replace(/\s*：\s*/g, "：")
    .replace(/\s+/g, " ")
    .trim();
}
export type DirectionOption = {
  groupId: string;
  name: string;
  min: number;
  max?: number;
};
/**
 * 方案把某一类按方向分列、自己不给总额（如物理学院的专业核心课：六个方向 18~24 学分）。
 * 不选方向就不知道这一类要修多少，也只能把各方向的课混在一起。
 * 父类已有总额的（如信科的专业选修课）不算分裂，那是模块清单而非互斥方向。
 */
export type DirectionSplit = {
  sectionId: string;
  name: string;
  options: DirectionOption[];
};
export function directionSplits(plan: Plan): DirectionSplit[] {
  const usesRequirements = plan.requirements.length >= 4;
  const parentIds = new Set(plan.groups.map((g) => g.id));
  const out: DirectionSplit[] = [];
  for (const parent of plan.groups) {
    if (parent.min !== undefined) continue;
    if (parent.parent === null || !parentIds.has(parent.parent)) continue;
    const options = plan.groups
      .filter(
        (child) =>
          child.parent === parent.id &&
          child.min !== undefined &&
          (child.id.startsWith(`${parent.id}-`) ||
            child.id.startsWith(`${parent.id}.`)),
      )
      .map((child) => ({
        groupId: child.id,
        name: tidy(child.name),
        min: child.min as number,
        max: child.max,
      }));
    if (options.length < 2) continue;
    out.push({
      sectionId: usesRequirements ? parent.id.replace(/\./g, "-") : parent.id,
      name: tidy(parent.name),
      options,
    });
  }
  return out;
}
/** 方向选择按「<方案 id>|<系列 id>」保存，这里读回当前方案的这一份。 */
export function directionsFor(
  planId: string,
  directions: Record<string, string>,
): Record<string, string> {
  const prefix = `${planId}|`;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(directions))
    if (key.startsWith(prefix)) out[key.slice(prefix.length)] = value;
  return out;
}
/** 用户选定方向后，这一类按该方向的学分计；其余方向独有的课不再算进这一类。 */
function applyDirection(
  split: DirectionSplit,
  flat: Map<string, ProgressSection>,
  plan: Plan,
  chosen: string,
): Set<string> {
  const section = flat.get(split.sectionId);
  const option = split.options.find((o) => o.groupId === chosen);
  if (!section || !option) return new Set();
  section.min = option.min;
  section.max = option.max ?? option.min;
  section.requirement = `${fmtCredits(option.min)} 学分`;
  section.note = `已选方向「${option.name}」，该类按 ${fmtCredits(option.min)} 学分计算`;
  const group = plan.groups.find((g) => g.id === option.groupId);
  if (!group) return new Set();
  const kept = new Set([
    ...group.courses.map((c) => normalizeCourseName(c.name)),
    ...group.alternatives.map((a) => normalizeCourseName(a.name)),
  ]);
  const skip = new Set<string>();
  for (const sibling of plan.groups) {
    if (
      sibling.parent !== group.parent ||
      sibling.id === group.id ||
      !split.options.some((o) => o.groupId === sibling.id)
    )
      continue;
    for (const key of [
      ...sibling.courses.map((c) => normalizeCourseName(c.name)),
      ...sibling.alternatives.map((a) => normalizeCourseName(a.name)),
    ]) {
      if (key && !kept.has(key)) skip.add(key);
    }
  }
  return skip;
}
/**
 * 方向或分级定了以后，大类的总额按各子系列求和。
 * 按门/按学时的子系列不计入（方案自己也没把它们算进学分总数），
 * 而且求和结果落在方案原本给的区间内才敢改。
 */
function recomputeTopTotal(
  top: ProgressSection,
  floor: number,
  ceiling: number,
) {
  const counted = top.children.filter(
    (child) => child.unit === undefined || child.unit === "学分",
  );
  if (!counted.length || counted.some((child) => child.min === undefined))
    return;
  const min = counted.reduce((sum, child) => sum + (child.min as number), 0);
  const max = counted.reduce(
    (sum, child) => sum + (child.max ?? child.min!),
    0,
  );
  if (min < floor || min > ceiling) return;
  top.min = min;
  top.max = max;
  top.requirement =
    max > min
      ? `${fmtCredits(min)}～${fmtCredits(max)} 学分`
      : `${fmtCredits(min)} 学分`;
}
/** 把方案整理成两层的学分系列，并建立课程名索引。 */
function buildSections(
  plan: Plan,
  directions: Record<string, string> = {},
): {
  sections: ProgressSection[];
  index: SectionIndex;
  usesRequirements: boolean;
} {
  const usesRequirements = plan.requirements.length >= 4;
  const flat = new Map<string, ProgressSection>();
  const sections: ProgressSection[] = [];
  const topNames: Record<string, string> = {
    "1": "公共基础课程",
    "2": "专业必修课程",
    "3": "选修课程",
  };
  if (usesRequirements) {
    // 有些方案（如 2025 物理学院-物理学）没给出三大类总额，但课程组里写了 min/max。
    const groupById = new Map<string, PlanGroup>();
    for (const g of plan.groups) groupById.set(g.id.replace(/\./g, "-"), g);
    for (const id of ["1", "2", "3"]) {
      const top = plan.topRequirements.find((t) => t.id === id);
      const group = groupById.get(id);
      const g = group && group.parent === null ? group : undefined;
      const s = makeSection(id, top?.name ?? g?.name ?? topNames[id] ?? id, {
        min: top?.min ?? g?.min,
        max: top?.max ?? g?.max,
        unit: top?.unit ?? g?.unit,
      });
      sections.push(s);
      flat.set(id, s);
    }
    for (const r of plan.requirements) {
      const parent = flat.get(r.parent) ?? flat.get("1")!;
      const s = makeSection(r.id, r.name, r);
      parent.children.push(s);
      flat.set(r.id, s);
    }
    // 要求表漏掉、只在课程组里出现的子系列（如物理学院的专业核心课）补回来，
    // 否则这些课只能挂到大类本身，界面上看不到单独一类。
    for (const g of plan.groups) {
      if (!SECOND_LEVEL_GROUP.test(g.id)) continue;
      const rid = g.id.replace(/\./g, "-");
      if (flat.has(rid)) continue;
      const parent = flat.get(rid.split("-")[0]);
      if (!parent) continue;
      const s = makeSection(rid, g.name.trim() ? g.name : rid, {
        requirement: g.requirement,
        min: g.min,
        max: g.max,
        unit: g.unit,
        note: g.note,
      });
      parent.children.push(s);
      flat.set(rid, s);
    }
    for (const top of sections)
      top.children.sort((a, b) => compareSectionIds(a.id, b.id));
  } else {
    for (const g of plan.groups.filter((g) => g.parent === null)) {
      const s = makeSection(g.id, g.name, g);
      sections.push(s);
      flat.set(g.id, s);
    }
    for (const g of plan.groups.filter((g) => g.parent !== null)) {
      let parentId = g.parent!;
      while (parentId && !flat.has(parentId) && parentId.includes("."))
        parentId = parentId.split(".").slice(0, -1).join(".");
      const parent = flat.get(parentId) ?? flat.get(parentId.split(/[.-]/)[0]);
      const s = makeSection(g.id, g.name, g);
      if (parent) parent.children.push(s);
      else {
        sections.push(s);
      }
      flat.set(g.id, s);
    }
  }
  for (const top of sections) deriveMissingTotals(top);

  // 选定细分方向后，这一类按该方向的学分计，其余方向独有的课不再算进来。
  const skip = new Set<string>();
  const touched: ProgressSection[] = [];
  for (const split of directionSplits(plan)) {
    const chosen = directions[split.sectionId];
    if (!chosen) continue;
    for (const key of applyDirection(split, flat, plan, chosen)) skip.add(key);
    const top = sections.find((s) =>
      s.children.some((child) => child.id === split.sectionId),
    );
    if (top) touched.push(top);
  }
  for (const top of touched) {
    if (top.min === undefined) continue;
    recomputeTopTotal(top, top.min, top.max ?? top.min);
  }

  const findChild = (re: RegExp) =>
    [...flat.values()].find(
      (s) => s.children.length === 0 && re.test(s.name),
    ) ?? null;
  const targets = {
    general: findChild(/通识/)?.id ?? null,
    publicRoot: flat.get("1")?.id ?? null,
    elective: findChild(/专业选修/)?.id ?? null,
    free: findChild(/自主选修|全校任选|任选/)?.id ?? null,
    major: flat.get("2")?.id ?? null,
  };
  const publicChildren = (flat.get("1")?.children ?? [])
    .map((section) => {
      const rule = PUBLIC_KEYWORDS.find(([sectionRe]) =>
        sectionRe.test(section.name),
      );
      return rule ? { section, nameRe: rule[1] } : null;
    })
    .filter(
      (x): x is { section: ProgressSection; nameRe: RegExp } => x !== null,
    );

  // 课程组 → 学分系列：a.b… → a-b；公共必修课表按关键词分到英语/思政/信息等；通识按名称。
  const sectionForGroup = (
    g: PlanGroup,
    course?: { name: string; code?: string },
  ): string | null => {
    if (!usesRequirements)
      return flat.has(g.id)
        ? g.id
        : g.parent && flat.has(g.parent)
          ? g.parent
          : null;
    if (/通识/.test(g.name) && targets.general) return targets.general;
    if (/^1(\.|$)/.test(g.id) || /公共必修/.test(g.name)) {
      if (course) {
        const hit = publicChildren.find((p) => p.nameRe.test(course.name));
        if (hit) return hit.section.id;
      }
      return targets.publicRoot;
    }
    const parts = g.id.split(/[.-]/);
    for (let n = Math.min(parts.length, 2); n >= 2; n--) {
      const rid = `${parts[0]}-${parts[1]}`;
      if (flat.has(rid)) return rid;
    }
    return flat.has(parts[0]) ? parts[0] : null;
  };

  const byName = new Map<
    string,
    { sectionId: string; credits: number | null; via: MatchVia }
  >();
  for (const g of plan.groups) {
    for (const c of g.courses) {
      const sectionId = sectionForGroup(g, c);
      if (!sectionId || !c.name) continue;
      const key = normalizeCourseName(c.name);
      if (skip.has(key)) continue;
      if (!byName.has(key))
        byName.set(key, { sectionId, credits: c.credits, via: "name" });
    }
    for (const a of g.alternatives) {
      if (!a.name) continue;
      const key = normalizeCourseName(a.name);
      if (byName.has(key) || skip.has(key)) continue;
      const replaced = a.replaces
        ? byName.get(normalizeCourseName(a.replaces))
        : undefined;
      const sectionId = replaced?.sectionId ?? sectionForGroup(g, a);
      if (sectionId)
        byName.set(key, { sectionId, credits: a.credits, via: "alternative" });
    }
  }
  return {
    sections,
    index: { byName, categoryTargets: targets, publicChildren, flat },
    usesRequirements,
  };
}

/**
 * 六级瀑布：手动归类 → 精确名 → 变体基名 → 反向变体 → 公共课关键词 → 课程类别。
 * 手动归类到此为止，不再从方案回填学分；在修课程也只认用户填的学分，
 * 因为方案数据里那些行大多没有解析出学分。
 */
function assign(
  course: MatchedCourse,
  index: SectionIndex,
  overrides: Overrides,
  backfill = true,
): MatchedCourse {
  const creditsOf = (fallback: number | null | undefined) =>
    backfill ? (course.credits ?? fallback ?? null) : course.credits;
  const key = normalizeCourseName(course.name);
  const override = overrides[key];
  if (override) return { ...course, sectionId: override, via: "override" };
  const assigned = assignByPlan(course, index, creditsOf);
  return assigned;
}

function assignByPlan(
  course: MatchedCourse,
  index: SectionIndex,
  creditsOf: (fallback: number | null | undefined) => number | null,
): MatchedCourse {
  const key = normalizeCourseName(course.name);
  const exact = index.byName.get(key);
  if (exact)
    return {
      ...course,
      sectionId: exact.sectionId,
      via: exact.via,
      credits: creditsOf(exact.credits),
    };
  const base = variantBase(key);
  if (base !== key) {
    const variant = index.byName.get(base);
    if (variant)
      return {
        ...course,
        sectionId: variant.sectionId,
        via: "variant",
        credits: creditsOf(variant.credits),
      };
  }
  for (const [k, v] of index.byName) {
    if (variantBase(k) === key)
      return {
        ...course,
        sectionId: v.sectionId,
        via: "variant",
        credits: creditsOf(v.credits),
      };
  }
  const publicHit = index.publicChildren.find((p) =>
    p.nameRe.test(course.name),
  );
  if (publicHit && !/专业/.test(course.category))
    return { ...course, sectionId: publicHit.section.id, via: "keyword" };
  const t = index.categoryTargets;
  const cat = course.category;
  if (/通选|通识/.test(cat) && t.general)
    return { ...course, sectionId: t.general, via: "category" };
  if (/全校必修|公共必修/.test(cat) && t.publicRoot)
    return { ...course, sectionId: t.publicRoot, via: "category" };
  if (/专业选修|限选/.test(cat) && t.elective)
    return { ...course, sectionId: t.elective, via: "category" };
  if (/任选|自主/.test(cat) && t.free)
    return { ...course, sectionId: t.free, via: "category" };
  return { ...course, sectionId: null, via: null };
}

export type ProgressOptions = {
  englishLevel?: EnglishLevel | null;
  /** 按方向分列的类别，键是 `<方案 id>|<系列 id>` 里的系列 id，值是选定的课程组 id。 */
  directions?: Record<string, string>;
  /** 手填学分，键是规范化课程名；已修与在修都以此为准，0 也是有效值。 */
  manualCredits?: Record<string, number>;
};

/** 原文第 1 条把英语专业学生和留学生排除在分级之外。 */
function isEnglishExempt(plan: Plan): boolean {
  const blob = [plan.title, plan.major, plan.track, plan.degree, plan.school]
    .filter((text): text is string => typeof text === "string")
    .join(" ");
  return (
    blob.includes("留学生") ||
    (blob.includes("英语") && blob.includes("外国语学院"))
  );
}
/**
 * 找出该被分级定住的那一类：方案单列了「大学英语」就用它；
 * 方案把英语折进「公共必修课」时，那一类的区间跨度恰好是英语弹性的 8-2=6。
 * 候选不唯一就不动，宁可不改。
 */
function englishSeries(
  index: SectionIndex,
): { section: ProgressSection; named: boolean } | null {
  const named = [...index.flat.values()].find(
    (s) =>
      s.children.length === 0 &&
      s.min !== undefined &&
      /大学英语|公共英语|大学外语/.test(s.name),
  );
  if (named) return { section: named, named: true };
  const root = index.flat.get("1");
  if (!root) return null;
  const span = ENGLISH_MAX_CREDITS - ENGLISH_MIN_CREDITS;
  const candidates = root.children.filter(
    (s) =>
      s.children.length === 0 &&
      s.min !== undefined &&
      s.max !== undefined &&
      Math.abs(s.max - s.min - span) < 0.001 &&
      /公共必修|外语|英语/.test(s.name),
  );
  return candidates.length === 1
    ? { section: candidates[0], named: false }
    : null;
}
/**
 * 分级决定「公共必修课」里大学英语要修多少学分：单列英语系列的直接定成该分档，
 * 折在公共必修课里的按「下限 +（所选 - 2）」落在方案自己给的区间内。
 * 之后大类总额按子系列求和、毕业总学分按大类求和，都带方案自述区间的围栏。
 */
function applyEnglishLevel(
  plan: Plan,
  sections: ProgressSection[],
  index: SectionIndex,
  level: EnglishLevel,
) {
  if (isEnglishExempt(plan)) return;
  const info = englishLevelInfo(level);
  if (!info) return;
  const found = englishSeries(index);
  if (!found) return;
  const series = found.section;
  if (series.min === undefined) return;
  const floor = series.min;
  const ceiling = series.max ?? floor;
  const pinned = found.named
    ? Math.min(Math.max(info.credits, floor), ceiling)
    : floor + (info.credits - ENGLISH_MIN_CREDITS);
  series.min = pinned;
  series.max = pinned;
  series.requirement = `${fmtCredits(pinned)} 学分（${info.label}）`;
  if (!found.named)
    series.note =
      `大学英语计入本类，学分要求弹性为 ${ENGLISH_MIN_CREDITS}～${ENGLISH_MAX_CREDITS}；` +
      `按${info.label}计为 ${fmtCredits(pinned)} 学分`;
  const top = sections.find((s) => s.children.includes(series));
  if (!top || top.min === undefined) return;
  recomputeTopTotal(top, top.min, top.max ?? top.min);
}

export function computeProgress(
  plan: Plan,
  scores: GradeCourse[],
  courses: CurrentCourse[],
  overrides: Overrides = {},
  options: ProgressOptions = {},
): Progress {
  const { sections, index, usesRequirements } = buildSections(
    plan,
    options.directions ?? {},
  );
  if (options.englishLevel)
    applyEnglishLevel(plan, sections, index, options.englishLevel);
  const seen = new Set<string>();
  const matched: MatchedCourse[] = [];
  scores.forEach((row, i) => {
    const status = scoreStatus(row.xqcj);
    // 成绩里那些根本不计分的记录（免修、退课、状态异常）不该把教学网本学期的同一门课
    // 挡在在修之外：学校有时先把还在上的课登进成绩单，桌面端就再也见不到它了。
    if (status !== "withdrawn" && status !== "other")
      seen.add(normalizeCourseName(row.kcmc));
    matched.push(
      assign(
        {
          key: `score:${i}`,
          name: row.kcmc,
          credits: decimal(row.xf),
          status,
          term: `${row.xnd}·${row.xq}`,
          category: row.kclbmc,
          score: row.xqcj,
          via: null,
          sectionId: null,
        },
        index,
        overrides,
      ),
    );
  });
  // 与安卓端同一套判据：教学网「当前」分组里的课就是在修，含「习题」的不算独立一门课
  // （教学网把习题课与正课并排列进来，算上就是重复计数）。已经结业的课在成绩里早有
  // 记录，按课程名去重时不会重复计入。
  for (const c of courses) {
    if (!c.current) continue;
    if (/习题/.test(c.name)) continue;
    const key = normalizeCourseName(c.name);
    if (seen.has(key)) continue;
    seen.add(key);
    matched.push(
      // 教学网课程列表不含学分，在修课程的学分不由方案回填。
      assign(
        {
          key: `course:${c.id}`,
          name: c.name,
          credits: null,
          status: "inProgress",
          term: c.semester ?? "本学期",
          category: "在修",
          score: "",
          via: null,
          sectionId: null,
        },
        index,
        overrides,
        false,
      ),
    );
  }
  const pending: MatchedCourse[] = [];
  const ignored: MatchedCourse[] = [];
  let unknownCredits = 0;
  for (const raw of matched) {
    // 手填过就以手填为准：成绩自带的学分与方案口径不一致时（0 学分课），改了就得生效。
    const manual = options.manualCredits?.[normalizeCourseName(raw.name)];
    const m = manual === undefined ? raw : { ...raw, credits: manual };
    if (m.sectionId === IGNORE) {
      ignored.push(m);
      continue;
    }
    if (m.status === "withdrawn" || m.status === "other") {
      ignored.push(m);
      continue;
    }
    const section = m.sectionId ? index.flat.get(m.sectionId) : undefined;
    if (!section) {
      pending.push(m);
      continue;
    }
    section.courses.push(m);
    if (m.status === "passed") {
      section.passedCount += 1;
      if (m.credits !== null) section.earned += m.credits;
      else unknownCredits += 1;
    } else if (m.status === "inProgress") {
      // 在修没填学分就只是列出，不计成「缺学分」的方案缺口。
      if (m.credits !== null) section.inProgress += m.credits;
    }
  }
  // 父级汇总子级。
  const rollup = (s: ProgressSection) => {
    for (const child of s.children) {
      rollup(child);
      s.earned += child.earned;
      s.inProgress += child.inProgress;
      s.passedCount += child.passedCount;
    }
  };
  sections.forEach(rollup);
  const earned = sections.reduce((n, s) => n + s.earned, 0);
  const inProgress = sections.reduce((n, s) => n + s.inProgress, 0);
  return {
    plan,
    sections,
    pending,
    ignored,
    totals: {
      required: recomputeRequired(plan, sections),
      earned,
      inProgress,
      unknownCredits,
    },
    usesRequirements,
  };
}

/** 学分系列的可选归类目标（叶子节点），供“待确认”下拉使用。 */
export function sectionChoices(
  progress: Progress,
): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  for (const top of progress.sections) {
    if (!top.children.length) out.push({ id: top.id, label: top.name });
    for (const child of top.children)
      out.push({ id: child.id, label: `${top.name} · ${child.name}` });
  }
  return out;
}

export type Inference = {
  cohort: number | null;
  version: number | null;
  candidates: {
    id: string;
    title: string;
    school: string | null;
    matched: number;
    total: number;
  }[];
  evidence: string[];
  /** 实际用于限定候选范围的方案 school 值；没有登记院系或没匹配上时为 null。 */
  narrowedBySchool: string | null;
};
function startYear(term: string): number | null {
  const m = /^(\d{2})-\d{2}/.exec(term.trim());
  return m ? 2000 + Number(m[1]) : null;
}
/** 门户登记的「单位」与方案 school 写法不完全一致，如「生命学院」与「生命科学学院」。 */
function schoolCore(name: string): string {
  let value = name;
  for (const suffix of ["学院", "大学", "系", "研究所"])
    value = value.endsWith(suffix)
      ? value.slice(0, value.length - suffix.length)
      : value;
  return value;
}
function sameSchool(a: string | null, b: string | null): boolean {
  if (!a?.trim() || !b?.trim()) return false;
  if (a === b) return true;
  const ca = schoolCore(a);
  const cb = schoolCore(b);
  return (
    ca.length >= 2 &&
    cb.length >= 2 &&
    (a.includes(b) ||
      b.includes(a) ||
      ca === cb ||
      ca.startsWith(cb) ||
      cb.startsWith(ca))
  );
}
/** 从成绩与课程学期推断入学年份，再按门户登记的院系限定范围，用专业必修课重合度排候选。 */
export function inferProfile(
  scores: GradeCourse[],
  courses: CurrentCourse[],
  index: PlanIndexEntry[] = planIndex,
  department: string | null = null,
): Inference {
  const years: number[] = [];
  for (const s of scores) {
    const y = startYear(s.xnd);
    if (y) years.push(y);
  }
  for (const c of courses) {
    const y = c.semester ? startYear(c.semester) : null;
    if (y) years.push(y);
  }
  const cohort = years.length ? Math.min(...years) : null;
  const version = defaultVersion(cohort);
  const evidence: string[] = [];
  if (cohort)
    evidence.push(
      `最早的成绩或课程学期是 ${cohort}-${String(cohort + 1).slice(2)} 学年，按此推断 ${cohort} 级`,
    );
  if (cohort !== null && version !== null && version !== cohort)
    evidence.push(`没有 ${cohort} 版培养方案，默认使用 ${version} 版`);
  const taken = new Set<string>();
  for (const s of scores) taken.add(normalizeCourseName(s.kcmc));
  for (const c of courses) taken.add(normalizeCourseName(c.name));
  const pool = index.filter(
    (p) => p.kind !== "project" && (version === null || p.cohort === version),
  );
  const ranked = (rows: PlanIndexEntry[]) =>
    rows
      .map((p) => {
        const core = p.core.map(normalizeCourseName);
        return {
          id: p.id,
          title: p.title,
          school: p.school,
          matched: core.filter((n) => taken.has(n) || taken.has(variantBase(n)))
            .length,
          total: core.length,
        };
      })
      .filter((c) => c.matched > 0)
      .sort(
        (a, b) =>
          b.matched - a.matched ||
          b.matched / Math.max(1, b.total) - a.matched / Math.max(1, a.total),
      )
      .slice(0, 5);
  // 先在登记院系内排序，该院系一门都不重合时退回全校，不做「猜不动就空着」。
  const school =
    pool.find((p) => sameSchool(p.school, department))?.school ?? null;
  let candidates: Inference["candidates"] = [];
  if (school) {
    candidates = ranked(pool.filter((p) => p.school === school));
    if (!candidates.length) {
      evidence.push(
        `门户登记院系为“${school}”，但该院系没有重合的专业必修课，改按全校方案排序`,
      );
      candidates = ranked(pool);
    } else evidence.push(`已按门户登记的院系“${school}”限定候选范围`);
  } else candidates = ranked(pool);
  if (candidates.length) {
    evidence.push(
      `与“${candidates[0].title}”的专业必修课重合 ${candidates[0].matched} 门`,
    );
    const ties = candidates
      .slice(1)
      .filter((c) => c.matched === candidates[0].matched);
    if (ties.length) {
      evidence.push(
        `“${ties.map((c) => c.title).join("”“")}”重合门数相同，请核对是否选对了专业`,
      );
    }
  } else
    evidence.push("已修与在修课程与各方案的专业必修课均无重合，请手动选择专业");
  return {
    cohort,
    version,
    candidates,
    evidence,
    narrowedBySchool: school,
  };
}
