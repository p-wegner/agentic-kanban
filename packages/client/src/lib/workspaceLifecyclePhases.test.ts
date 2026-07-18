import { describe, expect, it } from "vitest";
import {
  deriveWorkspaceLifecycle,
  formatPhaseDuration,
  type WorkspaceLifecycleInput,
} from "./workspaceLifecyclePhases.js";

const T0 = Date.parse("2026-07-18T10:00:00.000Z");
const MIN = 60_000;

/** Build an ISO string N minutes after the shared T0 anchor. */
function at(minutes: number): string {
  return new Date(T0 + minutes * MIN).toISOString();
}

function kinds(input: WorkspaceLifecycleInput, now: number) {
  return deriveWorkspaceLifecycle(input, now).phases.map((p) => p.kind);
}

describe("deriveWorkspaceLifecycle", () => {
  it("charts ordered created → setup → building → review phases for a merged workspace", () => {
    const lifecycle = deriveWorkspaceLifecycle(
      {
        createdAt: at(0),
        setup: { startedAt: at(1), endedAt: at(3) },
        sessions: [
          { startedAt: at(3), endedAt: at(20), triggerType: "agent" },
          { startedAt: at(22), endedAt: at(25), triggerType: "review" },
        ],
        mergedAt: at(30),
      },
      T0 + 40 * MIN, // now is after the merge — must be ignored
    );

    expect(lifecycle.terminal).toBe("merged");
    expect(lifecycle.phases.map((p) => p.kind)).toEqual(["created", "setup", "building", "review"]);
    // Segments are contiguous and end at mergedAt, not `now`.
    expect(lifecycle.startMs).toBe(T0);
    expect(lifecycle.endMs).toBe(T0 + 30 * MIN);
    expect(lifecycle.totalMs).toBe(30 * MIN);
    // Plausible per-phase durations.
    const byKind = Object.fromEntries(lifecycle.phases.map((p) => [p.kind, p.durationMs]));
    expect(byKind.created).toBe(1 * MIN);
    expect(byKind.setup).toBe(2 * MIN);
    expect(byKind.building).toBe(19 * MIN); // 3 → 22 (next boundary = review start)
    expect(byKind.review).toBe(8 * MIN); // 22 → 30 (mergedAt)
    // No phase is marked ongoing once merged.
    expect(lifecycle.phases.some((p) => p.ongoing)).toBe(false);
  });

  it("extends the current phase to `now` and marks it ongoing for a running workspace", () => {
    const now = T0 + 15 * MIN;
    const lifecycle = deriveWorkspaceLifecycle(
      {
        createdAt: at(0),
        setup: { startedAt: at(1), endedAt: at(2) },
        sessions: [{ startedAt: at(2), endedAt: null, triggerType: "agent" }],
      },
      now,
    );

    expect(lifecycle.terminal).toBe("ongoing");
    expect(lifecycle.phases.map((p) => p.kind)).toEqual(["created", "setup", "building"]);
    const building = lifecycle.phases.at(-1)!;
    expect(building.kind).toBe("building");
    expect(building.ongoing).toBe(true);
    expect(building.endMs).toBe(now);
    expect(building.durationMs).toBe(13 * MIN); // 2 → 15 (now)
  });

  it("handles a still-in-setup workspace (setup running, no sessions yet)", () => {
    const now = T0 + 5 * MIN;
    const lifecycle = deriveWorkspaceLifecycle(
      {
        createdAt: at(0),
        setup: { startedAt: at(1), endedAt: null },
        sessions: [],
      },
      now,
    );

    expect(lifecycle.terminal).toBe("ongoing");
    expect(lifecycle.phases.map((p) => p.kind)).toEqual(["created", "setup"]);
    const setup = lifecycle.phases.at(-1)!;
    expect(setup.ongoing).toBe(true);
    expect(setup.endMs).toBe(now);
    expect(setup.durationMs).toBe(4 * MIN); // 1 → 5 (now)
  });

  it("renders a single created phase for a just-created workspace with no setup/sessions", () => {
    const now = T0 + 30_000; // 30s in
    const lifecycle = deriveWorkspaceLifecycle({ createdAt: at(0), sessions: [] }, now);
    expect(lifecycle.phases.map((p) => p.kind)).toEqual(["created"]);
    expect(lifecycle.phases[0].ongoing).toBe(true);
    expect(lifecycle.phases[0].durationMs).toBe(30_000);
  });

  it("treats merge-type sessions as opening the review/landing phase even without a review session", () => {
    expect(
      kinds(
        {
          createdAt: at(0),
          sessions: [
            { startedAt: at(1), endedAt: at(10), triggerType: "agent" },
            { startedAt: at(12), endedAt: at(14), triggerType: "fix-and-merge" },
          ],
          mergedAt: at(15),
        },
        T0 + 20 * MIN,
      ),
    ).toEqual(["created", "building", "review"]);
  });

  it("marks a closed-without-merge workspace terminal 'closed' and caps at closedAt", () => {
    const lifecycle = deriveWorkspaceLifecycle(
      {
        createdAt: at(0),
        sessions: [{ startedAt: at(1), endedAt: at(5), triggerType: "agent" }],
        closedAt: at(8),
      },
      T0 + 40 * MIN,
    );
    expect(lifecycle.terminal).toBe("closed");
    expect(lifecycle.endMs).toBe(T0 + 8 * MIN);
    expect(lifecycle.phases.some((p) => p.ongoing)).toBe(false);
  });

  it("clamps out-of-order timestamps monotonically without producing negative durations", () => {
    const lifecycle = deriveWorkspaceLifecycle(
      {
        createdAt: at(10),
        // Setup started BEFORE createdAt (clock skew) — clamp up to createdAt.
        setup: { startedAt: at(2), endedAt: at(4) },
        sessions: [{ startedAt: at(12), endedAt: null, triggerType: "agent" }],
      },
      T0 + 20 * MIN,
    );
    expect(lifecycle.startMs).toBe(T0 + 10 * MIN);
    for (const p of lifecycle.phases) {
      expect(p.durationMs).toBeGreaterThanOrEqual(0);
      expect(p.startMs).toBeGreaterThanOrEqual(lifecycle.startMs);
      expect(p.endMs).toBeLessThanOrEqual(lifecycle.endMs);
    }
  });

  it("passes per-repo merge markers through for multi-repo overlay", () => {
    const markers = [
      { name: "leading", merged: true, stranded: false },
      { name: "auth-svc", merged: false, stranded: true },
    ];
    const lifecycle = deriveWorkspaceLifecycle(
      { createdAt: at(0), sessions: [{ startedAt: at(1), endedAt: null, triggerType: "agent" }], repoMarkers: markers },
      T0 + 10 * MIN,
    );
    expect(lifecycle.repoMarkers).toEqual(markers);
  });
});

describe("formatPhaseDuration", () => {
  it("formats sub-minute, minute, and hour durations", () => {
    expect(formatPhaseDuration(12_000)).toBe("12s");
    expect(formatPhaseDuration(3 * MIN + 4_000)).toBe("3m 4s");
    expect(formatPhaseDuration(80 * MIN)).toBe("1h 20m");
    expect(formatPhaseDuration(-5)).toBe("0s");
  });
});
