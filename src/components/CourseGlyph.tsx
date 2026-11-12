/** 课程的颜色：按课名算出六种国画颜料色里的一种，同一门课永远同一个颜色。 */
export function coursePigment(name: string): object {
  let hash = 2166136261;
  for (const ch of name)
    hash = Math.imul(hash ^ ch.codePointAt(0)!, 16777619) >>> 0;
  return { "--pigment": `var(--pigment-${(hash % 6) + 1})` };
}

/** 课程的小印记：课名首字配课程的颜色。 */
export default function CourseGlyph({ name }: { name: string }) {
  const first = [...name.replace(/^[\s\p{P}\p{S}]+/u, "")][0] ?? "课";
  return (
    <span
      className="course-glyph"
      style={coursePigment(name)}
      aria-hidden="true"
    >
      {first}
    </span>
  );
}
