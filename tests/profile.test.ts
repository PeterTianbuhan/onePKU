import { describe, expect, it } from "vitest";
import {
  emptyProfile,
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
