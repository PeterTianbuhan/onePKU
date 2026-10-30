// 解析 .private/curriculum-src/*.txt，套用 overrides/，写出 data/curriculum/。
// 用法：node scripts/curriculum/build.mjs [卷 id ...]   加 --fetch 先下载缺失的卷。
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseVolume } from "./parse.mjs";
import { fetchVolume, manifest, sourceDir } from "./fetch.mjs";
import { writeCatalog } from "./catalog.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const outDir = path.join(root, "data/curriculum");
const overrideDir = path.join(here, "overrides");

// 专业必修课名列表，供应用在不加载全部方案的情况下推断用户专业。
function coreSignature(plan) {
  const names = new Set();
  for (const g of plan.groups) {
    if (!/^2(\.|$)/.test(g.id)) continue;
    for (const c of g.courses) if (c.name) names.add(c.name);
    for (const a of g.alternatives ?? []) if (a.name) names.add(a.name);
  }
  // 课程组结构没解析出“2.x”时退回用全部课程名，避免签名为空。
  if (names.size < 5)
    for (const g of plan.groups)
      for (const c of g.courses) if (c.name) names.add(c.name);
  return [...names];
}
function indexEntry(plan, file) {
  return {
    id: plan.id,
    cohort: plan.cohort,
    school: plan.school,
    major: plan.major,
    track: plan.track,
    title: plan.title,
    kind: plan.kind,
    degree: plan.degree,
    totalCredits: plan.totalCredits,
    volume: plan.volume,
    file,
    courses: plan.groups.reduce((n, g) => n + g.courses.length, 0),
    warnings: plan.warnings.length,
    core: coreSignature(plan),
  };
}

// 标题无法提取的卷（2024）：用同院系、专业必修课重合度最高的其他年份方案补标题，并明确标注。
const jaccard = (a, b) => {
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return A.size + B.size - inter ? inter / (A.size + B.size - inter) : 0;
};
function referencePlans(excludeCohort) {
  const out = [];
  if (!existsSync(outDir)) return out;
  for (const cohort of readdirSync(outDir).filter(
    (d) => /^\d{4}$/.test(d) && Number(d) !== excludeCohort,
  )) {
    for (const f of readdirSync(path.join(outDir, cohort)).filter((f) =>
      f.endsWith(".json"),
    )) {
      const plan = JSON.parse(
        readFileSync(path.join(outDir, cohort, f), "utf8"),
      );
      if (!plan.untitled)
        out.push({
          cohort: plan.cohort,
          school: plan.school,
          title: plan.title,
          major: plan.major,
          track: plan.track,
          kind: plan.kind,
          core: coreSignature(plan),
        });
    }
  }
  return out;
}
function inferTitles(plans, volume) {
  const untitled = plans.filter((p) => p.untitled);
  if (!untitled.length) return;
  const refs = referencePlans(volume.cohort);
  const used = new Set();
  for (const plan of untitled) {
    const core = coreSignature(plan);
    const rank = (list) =>
      list
        .map((r) => ({ r, score: jaccard(core, r.core) }))
        .sort(
          (a, b) =>
            b.score - a.score ||
            Math.abs(a.r.cohort - volume.cohort) -
              Math.abs(b.r.cohort - volume.cohort),
        );
    let candidates = rank(refs.filter((r) => r.school === plan.school));
    let best =
      candidates.find((c) => !used.has(`${c.r.cohort}:${c.r.title}`)) ??
      candidates[0];
    // 院系更名或专业迁移（如环境学院并入工学院）时放宽到全校比对，但要求更高重合度。
    if (!best || best.score < 0.5) {
      candidates = rank(refs);
      const alt =
        candidates.find((c) => !used.has(`${c.r.cohort}:${c.r.title}`)) ??
        candidates[0];
      if (alt && alt.score >= 0.6) best = alt;
    }
    if (best && best.score >= 0.5) {
      used.add(`${best.r.cohort}:${best.r.title}`);
      plan.title = best.r.title;
      plan.major = best.r.major;
      plan.track = best.r.track;
      plan.kind = best.r.kind;
      plan.titleInference = {
        from: best.r.cohort,
        title: best.r.title,
        overlap: Number(best.score.toFixed(2)),
      };
      plan.id = [plan.cohort, plan.school, plan.major, plan.track]
        .filter(Boolean)
        .join("-")
        .replace(/[\/\s]+/g, "_");
      plan.warnings = plan.warnings.filter((w) => !w.includes("待推断"));
      plan.warnings.push(
        `专业名按 ${best.r.cohort} 版“${best.r.title}”推断（专业必修课重合度 ${(best.score * 100).toFixed(0)}%），请核对`,
      );
    } else {
      plan.title = `${plan.school} 未命名方案`;
      plan.major = plan.title;
      plan.warnings.push(
        `未找到可比对的其他年份方案${best ? `（最高重合度 ${(best.score * 100).toFixed(0)}%）` : ""}`,
      );
    }
  }
  const ids = new Map();
  for (const p of plans) {
    const n = (ids.get(p.id) ?? 0) + 1;
    ids.set(p.id, n);
    if (n > 1) p.id = `${p.id}-${n}`;
  }
}

function applyOverride(plan, override) {
  const out = structuredClone(plan);
  for (const key of [
    "major",
    "track",
    "school",
    "degree",
    "totalCredits",
    "requirements",
    "topRequirements",
  ])
    if (key in override) out[key] = override[key];
  if (override.notes) out.notes = [...out.notes, ...override.notes];
  if (override.groups) {
    for (const g of override.groups) {
      const idx = out.groups.findIndex((x) => x.id === g.id);
      if (g.remove) {
        if (idx >= 0) out.groups.splice(idx, 1);
        continue;
      }
      if (idx >= 0)
        out.groups[idx] = {
          ...out.groups[idx],
          ...g,
          courses: g.courses ?? out.groups[idx].courses,
          alternatives: g.alternatives ?? out.groups[idx].alternatives,
        };
      else out.groups.push({ courses: [], alternatives: [], ...g });
    }
  }
  if (override.resolvedWarnings)
    out.warnings = out.warnings.filter(
      (w) => !override.resolvedWarnings.some((r) => w.includes(r)),
    );
  out.override = true;
  return out;
}

const args = process.argv.slice(2);
const doFetch = args.includes("--fetch");
const wanted = args.filter((a) => !a.startsWith("--"));
const volumes = manifest.volumes.filter(
  (v) => wanted.length === 0 || wanted.includes(v.id),
);
const index = [];
const summary = [];
mkdirSync(outDir, { recursive: true });
for (const v of volumes) {
  const txt = path.join(sourceDir, `${v.id}.txt`);
  if (!existsSync(txt)) {
    if (!doFetch) {
      console.error(
        `缺少 ${txt}，先运行 node scripts/curriculum/fetch.mjs ${v.id} 或加 --fetch`,
      );
      continue;
    }
    await fetchVolume(v);
  }
  const { plans, warnings } = parseVolume(readFileSync(txt, "utf8"), v);
  inferTitles(plans, v);
  const dir = path.join(outDir, String(v.cohort));
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir))
    if (
      f.endsWith(".json") &&
      JSON.parse(readFileSync(path.join(dir, f), "utf8")).source?.volumeId ===
        v.id
    )
      rmSync(path.join(dir, f));
  let withWarnings = 0;
  for (let plan of plans) {
    const overridePath = path.join(overrideDir, `${plan.id}.json`);
    if (existsSync(overridePath))
      plan = applyOverride(
        plan,
        JSON.parse(readFileSync(overridePath, "utf8")),
      );
    if (plan.warnings.length) withWarnings++;
    const file = `${v.cohort}/${plan.id}.json`;
    writeFileSync(
      path.join(outDir, file),
      JSON.stringify(plan, null, 1) + "\n",
    );
    index.push(indexEntry(plan, file));
  }
  summary.push({
    volume: v.id,
    plans: plans.length,
    withWarnings,
    skipped: warnings.length,
  });
  for (const w of warnings) console.error(`[${v.id}] ${w}`);
}
// 其他卷已经生成的方案也要进索引。
for (const cohort of readdirSync(outDir).filter((d) => /^\d{4}$/.test(d))) {
  for (const f of readdirSync(path.join(outDir, cohort)).filter((f) =>
    f.endsWith(".json"),
  )) {
    const file = `${cohort}/${f}`;
    if (index.some((e) => e.file === file)) continue;
    const plan = JSON.parse(readFileSync(path.join(outDir, file), "utf8"));
    index.push(indexEntry(plan, file));
  }
}
index.sort(
  (a, b) =>
    b.cohort - a.cohort ||
    String(a.school).localeCompare(String(b.school), "zh") ||
    a.title.localeCompare(b.title, "zh"),
);
writeFileSync(
  path.join(outDir, "index.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString().slice(0, 10),
      source: manifest.page,
      plans: index,
    },
    null,
    1,
  ) + "\n",
);
console.table(summary);
console.log(`共 ${index.length} 份方案，索引写入 data/curriculum/index.json`);
console.log(
  `课名目录写入 data/curriculum/catalog.json：${writeCatalog()} 个课名`,
);
