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

export type GradeScope = "all" | "major";
export type GradeOverrides = { included: string[]; excluded: string[] };
export const emptyGradeOverrides: GradeOverrides = {
  included: [],
  excluded: [],
};
export const gradeCourseKey = (course: GradeCourse) =>
  JSON.stringify([
    course.xnd,
    course.xq,
    course.kcmc,
    course.kclbmc,
    course.xf,
  ]);
export const isMajorCourse = (course: GradeCourse) =>
  /专业必修|专业限选/.test(course.kclbmc);
export function countsAsMajor(course: GradeCourse, overrides: GradeOverrides) {
  const key = gradeCourseKey(course);
  return (
    !overrides.excluded.includes(key) &&
    (isMajorCourse(course) || overrides.included.includes(key))
  );
}
export function setGradeIncluded(
  overrides: GradeOverrides,
  course: GradeCourse,
  included: boolean,
): GradeOverrides {
  const key = gradeCourseKey(course);
  return {
    included: [
      ...overrides.included.filter((k) => k !== key),
      ...(included && !isMajorCourse(course) ? [key] : []),
    ],
    excluded: [
      ...overrides.excluded.filter((k) => k !== key),
      ...(!included && isMajorCourse(course) ? [key] : []),
    ],
  };
}

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

// PKU undergraduate grade rules, Article 13 (effective September 2019).
// Keep each returned assessment, including retakes; round only for display.
export function calculateGrades(courses: GradeCourse[]) {
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
