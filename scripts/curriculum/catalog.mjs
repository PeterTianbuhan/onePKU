// 从 data/curriculum/<年份>/*.json 汇总「课名 → 课号与学分」，写出 data/curriculum/catalog.json。
// 教学网的在修课只有课名，应用用它补课号和学分；课名规范化留给应用，这里只按原文聚合。
// 用法：node scripts/curriculum/catalog.mjs（build.mjs 结束时也会调用）。
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "../../data/curriculum");

export function writeCatalog() {
  const byName = new Map();
  for (const cohort of readdirSync(outDir).filter((d) => /^\d{4}$/.test(d))) {
    for (const f of readdirSync(path.join(outDir, cohort))) {
      if (!f.endsWith(".json")) continue;
      const plan = JSON.parse(
        readFileSync(path.join(outDir, cohort, f), "utf8"),
      );
      for (const g of plan.groups)
        for (const c of [...g.courses, ...(g.alternatives ?? [])]) {
          if (!c.name || !/^\d{8}$/.test(c.code ?? "")) continue;
          const pairs = byName.get(c.name) ?? new Set();
          pairs.add(`${c.code}|${c.credits ?? ""}`);
          byName.set(c.name, pairs);
        }
    }
  }
  const courses = Object.fromEntries(
    [...byName]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, pairs]) => [
        name,
        [...pairs].sort().map((p) => {
          const [code, credits] = p.split("|");
          return [code, credits === "" ? null : Number(credits)];
        }),
      ]),
  );
  writeFileSync(
    path.join(outDir, "catalog.json"),
    JSON.stringify({ courses }) + "\n",
  );
  return Object.keys(courses).length;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  console.log(`catalog.json：${writeCatalog()} 个课名`);
