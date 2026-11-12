import { useEffect, useState } from "react";
import { lunarDate, numeral, sky, solarTerm } from "../lib/almanac";
import ink from "../assets/weiming-ink.webp";

const beijing = (time: number, options: Intl.DateTimeFormatOptions) =>
  new Date(time).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    ...options,
  });

/** 月亮：亮面按月相画，上弦亮在右，下弦亮在左。 */
function Moon({ phase }: { phase: number }) {
  const r = 30;
  const waxing = phase < 0.5;
  const bulge = Math.cos(phase * 2 * Math.PI);
  const rx = Math.abs(bulge) * r;
  // 外缘走亮的那半边，再沿明暗交界线回来。
  const lit = `M0 ${-r}A${r} ${r} 0 0 1 0 ${r}A${rx} ${r} 0 0 ${bulge > 0 ? 0 : 1} 0 ${-r}Z`;
  return (
    <svg className="hero-orb moon" viewBox="-32 -32 64 64">
      <circle r={r} className="moon-dark" />
      <path
        d={lit}
        className="moon-lit"
        transform={waxing ? "" : "scale(-1 1)"}
      />
      <circle r={r} className="moon-rim" />
    </svg>
  );
}

/**
 * 今日页的画：未名湖的水墨、按北京时刻走的太阳或月亮、农历题款和节气印。
 * 画面每分钟对一次表。
 */
export default function TodayHero({ brief }: { brief: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  const [month, day] = new Date(now)
    .toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" })
    .split("-")
    .slice(1)
    .map(Number);
  const heaven = sky(now);
  const lunar = lunarDate(now);
  const term = solarTerm(now);
  const weekday = beijing(now, { weekday: "long" });
  return (
    <header className="today-hero" data-sky={heaven.phase}>
      <div
        className="hero-scene"
        aria-hidden="true"
        style={{ "--sx": heaven.x, "--sy": heaven.y } as object}
      >
        <div className="hero-wash" />
        {heaven.phase === "night" ? (
          <Moon phase={heaven.moon} />
        ) : (
          <i className="hero-orb sun" />
        )}
        <div
          className="hero-ink"
          style={{ "--ink-image": `url(${ink})` } as object}
        />
      </div>
      <div className="hero-lockup">
        <div className="hero-month">
          {numeral(month)}月<span>{weekday}</span>
        </div>
        <div className="hero-day">
          <h1 aria-label={`今日，${month}月${day}日，${weekday}`}>
            {numeral(day)}
          </h1>
          <div
            className="hero-colophon"
            role="img"
            aria-label={`农历${lunar.year}${lunar.day}，${term}`}
          >
            {lunar.year && (
              <span>
                {lunar.year}
                {lunar.day}
              </span>
            )}
            <i className="seal">{term}</i>
          </div>
        </div>
        <p className="today-brief">{brief}</p>
      </div>
    </header>
  );
}
