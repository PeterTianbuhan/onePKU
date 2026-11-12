/** 课程的小印记：课名首字配一种国画颜料色，同一门课永远同一个颜色。 */
export default function CourseGlyph({ name }: { name: string }) {
  const first = [...name.replace(/^[\s\p{P}\p{S}]+/u, "")][0] ?? "课";
  let hash = 2166136261;
  for (const ch of name)
    hash = Math.imul(hash ^ ch.codePointAt(0)!, 16777619) >>> 0;
  return (
    <span
      className="course-glyph"
      style={{ "--pigment": `var(--pigment-${(hash % 6) + 1})` } as object}
      aria-hidden="true"
    >
      {first}
    </span>
  );
}
