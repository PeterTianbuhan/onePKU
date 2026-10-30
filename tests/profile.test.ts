import { describe, expect, it } from "vitest";
import {
  emptyProfile,
  normalizeProfile,
  overridesForPlan,
  type Profile,
} from "../src/lib/profile";

const profile = (over: Partial<Profile>): Profile => ({
  ...emptyProfile,
  ...over,
});

describe("overridesForPlan", () => {
  it("keeps every key for the main plan while no secondary plan is set", () => {
    const saved = profile({
      overrides: { 高等数学: "1-1", 带冒号的键: "2-1" },
    });
    expect(overridesForPlan(saved, "plan-a")).toEqual({
      高等数学: "1-1",
      带冒号的键: "2-1",
    });
  });
  it("only takes the secondary plan's own prefixed keys away from the main plan", () => {
    const saved = profile({
      secondaryPlanId: "plan-b",
      overrides: {
        高等数学: "1-1",
        "plan-b:线性代数": "2-1",
        "别的方案:的键": "3-1",
      },
    });
    expect(overridesForPlan(saved, "plan-a")).toEqual({
      高等数学: "1-1",
      "别的方案:的键": "3-1",
    });
    expect(overridesForPlan(saved, "plan-b")).toEqual({ 线性代数: "2-1" });
  });
  it("reads an empty scope without a plan", () => {
    expect(overridesForPlan(profile({}), null)).toEqual({});
  });
});

describe("draft", () => {
  it("keeps valid draft courses and drops malformed ones", () => {
    const saved = normalizeProfile({
      draft: [
        { code: "04835310", name: "离散数学基础", credits: 3 },
        { code: "4835310", name: "课号不对", credits: 3 },
        { code: "04830080", name: "代数结构与组合数学", credits: "3" },
        null,
      ],
    });
    expect(saved?.draft).toEqual([
      { code: "04835310", name: "离散数学基础", credits: 3 },
      { code: "04830080", name: "代数结构与组合数学", credits: null },
    ]);
    expect(normalizeProfile({})?.draft).toEqual([]);
  });
});
