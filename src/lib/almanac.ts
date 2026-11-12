/** 北京的历与天象：农历、节气、日出日落、月相。只给今日页的画面用，精度到「哪一天、哪一刻钟」。 */

const DAY = 86400000;
const RAD = Math.PI / 180;
const LATITUDE = 39.99;
const LONGITUDE = 116.31;
const TERMS =
  "春分清明谷雨立夏小满芒种夏至小暑大暑立秋处暑白露秋分寒露霜降立冬小雪大雪冬至小寒大寒立春雨水惊蛰";
const DIGITS = "〇一二三四五六七八九";

/** 一到九十九的中文数字：十二、二十四。 */
export function numeral(n: number): string {
  if (n < 10) return DIGITS[n];
  const ones = n % 10 ? DIGITS[n % 10] : "";
  return (n < 20 ? "" : DIGITS[Math.floor(n / 10)]) + "十" + ones;
}

/** 太阳视黄经（度）。低精度公式，误差约 0.01°，够分清节气落在哪一天。 */
function sunLongitude(time: number): number {
  const n = time / DAY + 2440587.5 - 2451545;
  const g = (357.528 + 0.9856003 * n) * RAD;
  const l =
    280.46 + 0.9856474 * n + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g);
  return ((l % 360) + 360) % 360;
}

/** 北京时间这一天所在的节气。交节当天就算新节气。 */
export function solarTerm(time: number): string {
  const dayEnd = Math.floor((time + 8 * 3600000) / DAY + 1) * DAY - 8 * 3600000;
  const index = Math.floor(sunLongitude(dayEnd - 1000) / 15);
  return TERMS.slice(index * 2, index * 2 + 2);
}

/** 农历：「丙午年」「十月初四」。运行环境不带农历时返回空串。 */
export function lunarDate(time: number): { year: string; day: string } {
  try {
    const parts = new Intl.DateTimeFormat("zh-CN-u-ca-chinese", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "long",
      day: "numeric",
    }).formatToParts(time);
    const get = (type: string) =>
      parts.find((part) => (part.type as string) === type)?.value ?? "";
    // 日子：有的内核给数字 4，有的直接给「初四」，两种都认。
    const raw = get("day");
    const d = Number(raw);
    const name = !d
      ? raw
      : d <= 10
        ? `初${numeral(d)}`
        : d < 20
          ? numeral(d)
          : d === 20
            ? "二十"
            : d < 30
              ? `廿${DIGITS[d - 20]}`
              : "三十";
    if (!get("yearName") || !name) return { year: "", day: "" };
    return { year: `${get("yearName")}年`, day: `${get("month")}${name}` };
  } catch {
    return { year: "", day: "" };
  }
}

/** 北京时间的钟点，带小数：17.5 是下午五点半。 */
export function beijingHour(time: number): number {
  return ((((time + 8 * 3600000) % DAY) + DAY) % DAY) / 3600000;
}

/** 燕园当天的日出、日落（北京时间钟点）。含时差与大气折射，误差几分钟。 */
export function sunTimes(time: number): { rise: number; set: number } {
  const lambda = sunLongitude(time) * RAD;
  const decl = Math.asin(Math.sin(23.44 * RAD) * Math.sin(lambda));
  const phi = LATITUDE * RAD;
  const cosH =
    (Math.sin(-0.833 * RAD) - Math.sin(phi) * Math.sin(decl)) /
    (Math.cos(phi) * Math.cos(decl));
  const half = Math.acos(Math.max(-1, Math.min(1, cosH))) / RAD / 15;
  // 时差：真太阳时与钟表时间的差，一年里在 −14 到 +16 分钟之间摆。
  const n = time / DAY + 2440587.5 - 2451545;
  const b = (360 / 365.24) * (n - 81) * RAD;
  const equation =
    (9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b)) / 60;
  const noon = 12 + (120 - LONGITUDE) / 15 - equation;
  return { rise: noon - half, set: noon + half };
}

/** 月相：0 是朔，0.5 是望，接近 1 又回到朔。 */
export function moonPhase(time: number): number {
  const synodic = 29.530588853;
  const newMoon = Date.UTC(2000, 0, 6, 18, 14);
  return (((((time - newMoon) / DAY) % synodic) + synodic) % synodic) / synodic;
}

export type Sky = {
  phase: "dawn" | "day" | "dusk" | "night";
  /** 日或月在画面里的位置，0 到 1：x 从东到西，y 是离地平线的高度。 */
  x: number;
  y: number;
  moon: number;
};

/** 此刻的天：晨、昼、昏、夜，以及日月走到了哪里。 */
export function sky(time: number): Sky {
  const hour = beijingHour(time);
  const { rise, set } = sunTimes(time);
  const moon = moonPhase(time);
  if (hour >= rise - 0.5 && hour <= set + 0.5) {
    const t = Math.max(0, Math.min(1, (hour - rise) / (set - rise)));
    const phase =
      hour < rise + 1.25 ? "dawn" : hour > set - 1.25 ? "dusk" : "day";
    return { phase, x: t, y: Math.sin(t * Math.PI), moon };
  }
  // 夜里画月亮：从日落走到日出。
  const night = 24 - (set - rise);
  const since = hour > set ? hour - set : hour + 24 - set;
  const t = Math.max(0, Math.min(1, since / night));
  return { phase: "night", x: t, y: Math.sin(t * Math.PI), moon };
}
