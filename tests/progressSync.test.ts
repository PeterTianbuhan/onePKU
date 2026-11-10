import { expect, it } from "vitest";
import { mergeProgress, type ProgressRecord } from "../src/lib/progressSync";

function record(overrides: Partial<ProgressRecord> = {}): ProgressRecord {
  return {
    courseId: "course-1",
    episodeId: "episode-1",
    positionSeconds: 10,
    completed: false,
    updatedAt: "2026-11-10T00:00:00.000Z",
    ...overrides,
  };
}

it("keeps the newer position and a completed flag from either side", () => {
  const newer = mergeProgress(
    record({
      positionSeconds: 10,
      completed: true,
      updatedAt: "2026-11-10T00:00:00.000Z",
    }),
    record({
      positionSeconds: 15,
      completed: false,
      updatedAt: "2026-11-10T00:05:00.000Z",
    }),
  );
  expect(newer?.positionSeconds).toBe(15);
  expect(newer?.completed).toBe(true);

  const older = mergeProgress(
    record({ positionSeconds: 40, updatedAt: "2026-11-10T00:02:00.000Z" }),
    record({ positionSeconds: 5, updatedAt: "2026-11-10T00:01:00.000Z" }),
  );
  expect(older?.positionSeconds).toBe(40);

  const tie = mergeProgress(
    record({ positionSeconds: 10 }),
    record({ positionSeconds: 12 }),
  );
  expect(tie?.positionSeconds).toBe(12);

  const finished = mergeProgress(
    record(),
    record({
      positionSeconds: 80,
      completed: true,
      updatedAt: "2026-11-10T00:05:00.000Z",
    }),
  );
  expect(finished?.completed).toBe(true);
  expect(finished?.positionSeconds).toBe(80);
});
