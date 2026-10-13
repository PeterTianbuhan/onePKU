export type GradeCourse = {
  kcmc: string;
  xf: string;
  xqcj: string;
  kclbmc: string;
  xnd: string;
  xq: string;
};

export type Scores = {
  courses: GradeCourse[];
  semester_gpas: { gpa: string; xndxq: string }[];
  overall_gpa: string;
  total_credits: string;
};

export const gradeRulesUrl =
  "https://dean.pku.edu.cn/web/rules_info.php?id=173";

function decimal(value: string): number | null {
  const text = value.trim();
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

export function officialGpa(value: string | undefined): number | null {
  const number = decimal(value ?? "");
  return number !== null && number <= 4 ? number : null;
}

export type GradeScope = "all" | "major";
export const gradeScopeLabels: Record<GradeScope, string> = {
  all: "全部课程",
  major: "专业必修/限选",
};
/** 手动调整口径：有些专业课在学校系统里被标成「任选」，按类别自动统计会漏掉。 */
export type ScopeOverride = { included: string[]; excluded: string[] };
export const emptyScopeOverride: ScopeOverride = { included: [], excluded: [] };
/** 只认两个字符串数组，其余（包括旧数据）一律当作没有调整。 */
export function normalizeScope(value: unknown): ScopeOverride {
  if (!value || typeof value !== "object") return emptyScopeOverride;
  const v = value as Partial<ScopeOverride>;
  const list = (items: unknown) =>
    Array.isArray(items)
      ? items.filter((item): item is string => typeof item === "string")
      : [];
  return { included: list(v.included), excluded: list(v.excluded) };
}
/** 同一学期同名课程视为一条，作为口径调整的稳定标识。 */
export function scopeKeyOf(course: GradeCourse): string {
  return `${course.xnd}-${course.xq}|${course.kcmc}`;
}
export function isMajorRequired(course: GradeCourse): boolean {
  return (
    course.kclbmc.includes("专业必修") || course.kclbmc.includes("专业限选")
  );
}
export function countsAsMajor(
  course: GradeCourse,
  override: ScopeOverride = emptyScopeOverride,
): boolean {
  const key = scopeKeyOf(course);
  return (
    override.included.includes(key) ||
    (isMajorRequired(course) && !override.excluded.includes(key))
  );
}
export function inScope(
  course: GradeCourse,
  scope: GradeScope,
  override: ScopeOverride = emptyScopeOverride,
): boolean {
  return scope === "all" || countsAsMajor(course, override);
}
/** 与安卓端一致：本来就计入的只需取消；标错类别的手动加进来。 */
export function toggleScope(
  override: ScopeOverride,
  course: GradeCourse,
  want: boolean,
): ScopeOverride {
  const key = scopeKeyOf(course);
  const included = override.included.filter((item) => item !== key);
  const excluded = override.excluded.filter((item) => item !== key);
  if (want) {
    // 本来就按类别计入的课不需要覆盖；标错类别的才手动加。
    if (!isMajorRequired(course)) included.push(key);
  } else if (isMajorRequired(course)) {
    excluded.push(key);
  }
  return { included, excluded };
}

// PKU undergraduate grade rules, Article 13 (effective September 2019).
// Keep each returned assessment, including retakes; round only for display.
export function calculateGrades(
  input: GradeCourse[],
  scope: GradeScope = "all",
  override: ScopeOverride = emptyScopeOverride,
) {
  const courses = input.filter((course) => inScope(course, scope, override));
  let credits = 0;
  let gradePoints = 0;
  let scores = 0;
  let included = 0;
  for (const course of courses) {
    const score = decimal(course.xqcj);
    const credit = decimal(course.xf);
    // The source has no eligibility flag. Recognize explicit course labels;
    // disclose this boundary in the calculation details.
    const excludedCourse = /毕业论文|综合性考试/.test(
      `${course.kcmc} ${course.kclbmc}`,
    );
    if (
      score === null ||
      score > 100 ||
      credit === null ||
      credit <= 0 ||
      excludedCourse
    )
      continue;
    const points = score < 60 ? 0 : 4 - (3 * (100 - score) ** 2) / 1600;
    credits += credit;
    gradePoints += points * credit;
    scores += score * credit;
    included += 1;
  }
  return {
    gpa: credits > 0 ? gradePoints / credits : null,
    average: credits > 0 ? scores / credits : null,
    credits,
    included,
    excluded: courses.length - included,
  };
}
