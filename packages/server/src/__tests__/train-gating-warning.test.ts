import { describe, it, expect } from "vitest";
// @ts-expect-error plain .mjs script
import { formatTrainWarnings } from "../../../../scripts/train-gating-warning.mjs";

const train = (state: string, label = "2026-10-18-04") => ({ state, label, startedAt: new Date(2026, 9, 18, 14, 5).toISOString() });

describe("train-gating-warning (#1607)", () => {
  it("names a gating train and when it started", () => {
    expect(formatTrainWarnings([train("gating")])).toEqual([
      "train/2026-10-18-04 is gating since 14:05; a commit now moves its base",
    ]);
  });
  it("ignores terminal and assembling trains, and keeps an existing train/ prefix", () => {
    expect(formatTrainWarnings([train("landed"), train("red"), train("assembling")])).toEqual([]);
    expect(formatTrainWarnings([train("landing", "train/x")])[0]).toMatch(/^train\/x is landing/);
  });
});
