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
  inferred: boolean;
  updatedAt: string;
};

export const emptyProfile: Profile = {
  cohort: null,
  planId: null,
  secondaryPlanId: null,
  englishLevel: null,
  overrides: {},
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
    inferred: Boolean(v.inferred),
    updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : "",
  };
}

export async function saveProfile(profile: Profile): Promise<Profile> {
  const next = { ...profile, updatedAt: new Date().toISOString() };
  await action({ kind: "setProfile", profile: next });
  return next;
}

export const onboardingSeenKey = "onepku.onboarding.v1";
