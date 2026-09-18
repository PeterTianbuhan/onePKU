import { useMemo, useState } from "react";
import {
  defaultVersion,
  ENGLISH_LEVELS,
  planIndex,
  planVersions,
  type Inference,
} from "../lib/curriculum";
import type { Profile } from "../lib/profile";

/** 年级、方案版本、院系、专业与可选双学位方案。所有字段可改，推断只用来预填。 */
export default function ProfileForm({
  value,
  onChange,
  inference,
}: {
  value: Profile;
  onChange: (next: Profile) => void;
  inference?: Inference;
}) {
  const versions = planVersions();
  const currentPlan = planIndex.find((p) => p.id === value.planId);
  // 用户选了一个没有对应专业的版本时，先记住版本，直到选出专业为止。
  const [pendingVersion, setPendingVersion] = useState<number | null>(null);
  const version =
    currentPlan?.cohort ??
    pendingVersion ??
    defaultVersion(value.cohort) ??
    versions[0];
  const plans = useMemo(
    () => planIndex.filter((p) => p.cohort === version),
    [version],
  );
  const schools = useMemo(
    () =>
      [...new Set(plans.map((p) => p.school ?? "未知院系"))].sort((a, b) =>
        a.localeCompare(b, "zh"),
      ),
    [plans],
  );
  const school = currentPlan?.school ?? "";
  const majors = plans.filter((p) => (p.school ?? "未知院系") === school);
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: 12 }, (_, i) => thisYear - i);

  const setVersion = (v: number) => {
    // 换版本时尽量保留同院系同专业。
    const same = currentPlan
      ? planIndex.find(
          (p) =>
            p.cohort === v &&
            p.school === currentPlan.school &&
            p.major === currentPlan.major &&
            p.track === currentPlan.track,
        )
      : undefined;
    setPendingVersion(same ? null : v);
    onChange({
      ...value,
      planId: same?.id ?? null,
      inferred: false,
    });
  };

  return (
    <div className="profile-form">
      <label>
        <span>入学年份</span>
        <select
          aria-label="入学年份"
          value={value.cohort ?? ""}
          onChange={(e) => {
            const cohort = e.target.value ? Number(e.target.value) : null;
            const v = defaultVersion(cohort);
            const same =
              currentPlan && v
                ? planIndex.find(
                    (p) =>
                      p.cohort === v &&
                      p.school === currentPlan.school &&
                      p.major === currentPlan.major &&
                      p.track === currentPlan.track,
                  )
                : undefined;
            setPendingVersion(null);
            onChange({
              ...value,
              cohort,
              planId: same?.id ?? (v === version ? value.planId : null),
              inferred: false,
            });
          }}
        >
          <option value="">未填写</option>
          {years.map((y) => (
            <option key={y} value={y}>
              {y} 级
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>方案版本</span>
        <select
          aria-label="培养方案版本"
          value={version}
          onChange={(e) => setVersion(Number(e.target.value))}
        >
          {versions.map((v) => (
            <option key={v} value={v}>
              {v} 版
              {value.cohort && v === defaultVersion(value.cohort)
                ? "（按入学年份默认）"
                : ""}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>院系</span>
        <select
          aria-label="院系"
          value={school}
          onChange={(e) => {
            const first = plans.find(
              (p) => (p.school ?? "未知院系") === e.target.value,
            );
            onChange({ ...value, planId: first?.id ?? null, inferred: false });
          }}
        >
          <option value="">请选择</option>
          {schools.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>专业 / 方向</span>
        <select
          aria-label="专业"
          value={value.planId ?? ""}
          disabled={!school}
          onChange={(e) =>
            onChange({
              ...value,
              planId: e.target.value || null,
              inferred: false,
            })
          }
        >
          <option value="">请选择</option>
          {majors.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
              {p.kind === "project" ? "（项目）" : ""}
              {p.warnings ? " ·数据待核对" : ""}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>双学位 / 辅修方案（可选）</span>
        <select
          aria-label="双学位或辅修方案"
          value={value.secondaryPlanId ?? ""}
          onChange={(e) =>
            onChange({ ...value, secondaryPlanId: e.target.value || null })
          }
        >
          <option value="">无</option>
          {plans
            .filter((p) => p.id !== value.planId)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.school} · {p.title}
              </option>
            ))}
        </select>
      </label>
      <label>
        <span>大学英语分级</span>
        <select
          aria-label="大学英语分级"
          value={value.englishLevel ?? ""}
          onChange={(e) =>
            onChange({
              ...value,
              englishLevel: (e.target.value || null) as Profile["englishLevel"],
            })
          }
        >
          <option value="">未选择（按方案 2～8 学分）</option>
          {ENGLISH_LEVELS.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}（{l.credits} 学分）
            </option>
          ))}
        </select>
      </label>
      {inference && inference.candidates.length > 0 && (
        <div className="profile-suggestions">
          <span>按已修课程推断的候选：</span>
          {inference.candidates.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`chip ${value.planId === c.id ? "active" : ""}`}
              onClick={() =>
                onChange({
                  ...value,
                  planId: c.id,
                  cohort:
                    value.cohort ??
                    planIndex.find((p) => p.id === c.id)?.cohort ??
                    null,
                  inferred: true,
                })
              }
              title={`专业必修课重合 ${c.matched} 门`}
            >
              {c.school} · {c.title}
              <small>{c.matched} 门重合</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
