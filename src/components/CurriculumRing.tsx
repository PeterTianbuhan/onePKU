/** 学分圆环：已获为主色实弧，在修为浅色弧，超出要求的部分不再增长。 */
export default function CurriculumRing({
  value,
  pending = 0,
  target,
  size = 128,
  stroke = 11,
  complete = false,
  children,
}: {
  value: number;
  pending?: number;
  target: number | null;
  size?: number;
  stroke?: number;
  complete?: boolean;
  children?: React.ReactNode;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const ratio = (n: number) =>
    target && target > 0 ? Math.min(1, Math.max(0, n / target)) : 0;
  const done = ratio(value);
  const withPending = ratio(value + pending);
  return (
    <div
      className={`ring ${complete ? "complete" : ""}`}
      style={{ width: size, height: size }}
    >
      <svg viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle
          className="ring-track"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
        />
        {withPending > done && (
          <circle
            className="ring-pending"
            cx={size / 2}
            cy={size / 2}
            r={r}
            strokeWidth={stroke}
            strokeDasharray={`${c * withPending} ${c}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
        {done > 0 && (
          <circle
            className="ring-done"
            cx={size / 2}
            cy={size / 2}
            r={r}
            strokeWidth={stroke}
            strokeDasharray={`${c * done} ${c}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
      </svg>
      <div className="ring-center">{children}</div>
    </div>
  );
}
