// 用户资料：年级、培养方案与待确认归类。只存本机 preferences.json，不含任何凭证。
import { useResource, action } from "./api";
import {
  ENGLISH_LEVELS,
  type EnglishLevel,
  type Overrides,
} from "./curriculum";

export type Profile = {
  cohort: number | null;
  planId: string | null;
  secondaryPlanId: string | null;
  /** 大学英语分级；null 表示未选择，按方案的 2～8 学分区间显示。 */
  englishLevel: EnglishLevel | null;
  overrides: Overrides;
  /** 按方向分列的类别选了哪个方向：键是「<方案 id>|<系列 id>」，值是课程组 id。 */
  directions: Record<string, string>;
  /** 手填学分，键是规范化课程名；已修与在修都以此为准，0 也是有效值。 */
  manualCredits: Record<string, number>;
  inferred: boolean;
  updatedAt: string;
};

export const emptyProfile: Profile = {
  cohort: null,
  planId: null,
  secondaryPlanId: null,
  englishLevel: null,
  overrides: {},
  directions: {},
  manualCredits: {},
  inferred: false,
  updatedAt: "",
};

export function useProfile() {
  return useResource<Profile | null>({ kind: "profile" });
}

export function normalizeProfile(value: unknown): Profile | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<Profile>;
  return {
    cohort: typeof v.cohort === "number" ? v.cohort : null,
    planId: typeof v.planId === "string" ? v.planId : null,
    secondaryPlanId:
      typeof v.secondaryPlanId === "string" ? v.secondaryPlanId : null,
    englishLevel: ENGLISH_LEVELS.some((l) => l.id === v.englishLevel)
      ? (v.englishLevel as EnglishLevel)
      : null,
    overrides:
      v.overrides && typeof v.overrides === "object"
        ? Object.fromEntries(
            Object.entries(v.overrides).filter(
              ([, s]) => typeof s === "string",
            ),
          )
        : {},
    directions:
      v.directions && typeof v.directions === "object"
        ? Object.fromEntries(
            Object.entries(v.directions).filter(
              ([key, value]) =>
                typeof key === "string" && typeof value === "string",
            ),
          )
        : {},
    manualCredits:
      v.manualCredits && typeof v.manualCredits === "object"
        ? Object.fromEntries(
            Object.entries(v.manualCredits).filter(
              ([key, credits]) =>
                typeof key === "string" &&
                typeof credits === "number" &&
                Number.isFinite(credits) &&
                credits >= 0,
            ),
          )
        : {},
    inferred: Boolean(v.inferred),
    updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : "",
  };
}

/**
 * 取某个方案该用的手动归类：双学位的键带「辅修方案 id:」前缀，取用时剥掉；
 * 没有辅修时，含冒号的键仍属于主修，不能一概判给双学位。
 */
export function overridesForPlan(
  profile: Profile,
  planId: string | null,
): Overrides {
  const secondary = profile.secondaryPlanId;
  if (planId !== null && secondary !== null && planId === secondary) {
    const prefix = `${secondary}:`;
    return Object.fromEntries(
      Object.entries(profile.overrides)
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => [key.slice(prefix.length), value]),
    );
  }
  return Object.fromEntries(
    Object.entries(profile.overrides).filter(
      ([key]) =>
        !key.includes(":") || !secondary || !key.startsWith(`${secondary}:`),
    ),
  );
}

export async function saveProfile(profile: Profile): Promise<Profile> {
  const next = { ...profile, updatedAt: new Date().toISOString() };
  await action({ kind: "setProfile", profile: next });
  return next;
}

export const onboardingSeenKey = "onepku.onboarding.v1";
