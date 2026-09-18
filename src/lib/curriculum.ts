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
export const ENGLISH_FULL_CREDITS = 8;
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

/** 把方案整理成两层的学分系列，并建立课程名索引。 */
function buildSections(plan: Plan): {
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
    for (const id of ["1", "2", "3"]) {
      const top = plan.topRequirements.find((t) => t.id === id);
      const s = makeSection(id, top?.name ?? topNames[id], top ?? {});
      sections.push(s);
      flat.set(id, s);
    }
    for (const r of plan.requirements) {
      const parent = flat.get(r.parent) ?? flat.get("1")!;
      const s = makeSection(r.id, r.name, r);
      parent.children.push(s);
      flat.set(r.id, s);
    }
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
      if (!byName.has(key))
        byName.set(key, { sectionId, credits: c.credits, via: "name" });
    }
    for (const a of g.alternatives) {
      if (!a.name) continue;
      const key = normalizeCourseName(a.name);
      if (byName.has(key)) continue;
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

function assign(
  course: MatchedCourse,
  index: SectionIndex,
  overrides: Overrides,
): MatchedCourse {
  const key = normalizeCourseName(course.name);
  const override = overrides[key];
  if (override)
    return {
      ...course,
      sectionId: override === IGNORE ? IGNORE : override,
      via: "override",
    };
  const exact = index.byName.get(key);
  if (exact)
    return {
      ...course,
      sectionId: exact.sectionId,
      via: exact.via,
      credits: course.credits ?? exact.credits,
    };
  const base = variantBase(key);
  if (base !== key) {
    const variant = index.byName.get(base);
    if (variant)
      return {
        ...course,
        sectionId: variant.sectionId,
        via: "variant",
        credits: course.credits ?? variant.credits,
      };
  }
  for (const [k, v] of index.byName) {
    if (variantBase(k) === key)
      return {
        ...course,
        sectionId: v.sectionId,
        via: "variant",
        credits: course.credits ?? v.credits,
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

export type ProgressOptions = { englishLevel?: EnglishLevel | null };

/** 按分级把"大学英语 2～8 学分"固定下来；不足 8 学分的部分方案要求用专业或通识选修补齐，这里按通识教育课计。 */
function applyEnglishLevel(
  sections: ProgressSection[],
  index: SectionIndex,
  level: EnglishLevel,
) {
  const info = englishLevelInfo(level);
  if (!info) return;
  const english = [...index.flat.values()].find(
    (s) => s.children.length === 0 && /大学英语|英语/.test(s.name),
  );
  if (!english || english.min === undefined) return;
  const full = english.max ?? ENGLISH_FULL_CREDITS;
  english.min = info.credits;
  english.max = info.credits;
  english.requirement = `${info.credits} 学分（${info.label}）`;
  const shortfall = Math.max(0, full - info.credits);
  if (shortfall > 0) {
    const general = index.categoryTargets.general
      ? index.flat.get(index.categoryTargets.general)
      : undefined;
    if (general && general.min !== undefined) {
      general.min += shortfall;
      general.max = (general.max ?? general.min - shortfall) + shortfall;
      general.requirement = `${general.min} 学分（含补齐大学英语 ${shortfall} 学分）`;
      general.note = "方案允许用专业或通识选修补齐英语差额，这里按通识计";
    }
  }
  const top = sections.find((s) => s.children.includes(english));
  if (
    top &&
    top.min !== undefined &&
    top.max !== undefined &&
    top.min !== top.max
  ) {
    top.min = top.max;
    top.requirement = `${top.max} 学分`;
  }
}

export function computeProgress(
  plan: Plan,
  scores: GradeCourse[],
  courses: CurrentCourse[],
  overrides: Overrides = {},
  options: ProgressOptions = {},
): Progress {
  const { sections, index, usesRequirements } = buildSections(plan);
  if (options.englishLevel && usesRequirements)
    applyEnglishLevel(sections, index, options.englishLevel);
  const seen = new Set<string>();
  const matched: MatchedCourse[] = [];
  scores.forEach((row, i) => {
    const key = normalizeCourseName(row.kcmc);
    seen.add(key);
    matched.push(
      assign(
        {
          key: `score:${i}`,
          name: row.kcmc,
          credits: decimal(row.xf),
          status: scoreStatus(row.xqcj),
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
  for (const c of courses) {
    if (!c.current) continue;
    const key = normalizeCourseName(c.name);
    if (seen.has(key)) continue;
    seen.add(key);
    matched.push(
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
      ),
    );
  }
  const pending: MatchedCourse[] = [];
  const ignored: MatchedCourse[] = [];
  let unknownCredits = 0;
  for (const m of matched) {
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
      if (m.credits !== null) section.inProgress += m.credits;
      else unknownCredits += 1;
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
      required: plan.totalCredits?.min ?? null,
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
};
function startYear(term: string): number | null {
  const m = /^(\d{2})-\d{2}/.exec(term.trim());
  return m ? 2000 + Number(m[1]) : null;
}
/** 从成绩与课程学期推断入学年份，再用专业必修课重合度排出候选方案。 */
export function inferProfile(
  scores: GradeCourse[],
  courses: CurrentCourse[],
  index: PlanIndexEntry[] = planIndex,
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
  const candidates = pool
    .map((p) => {
      const core = p.core.map(normalizeCourseName);
      const matched = core.filter(
        (n) => taken.has(n) || taken.has(variantBase(n)),
      ).length;
      return {
        id: p.id,
        title: p.title,
        school: p.school,
        matched,
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
  } else evidence.push("没有一门课与任何方案的专业必修课重合，请手动选择专业");
  return { cohort, version, candidates, evidence };
}
