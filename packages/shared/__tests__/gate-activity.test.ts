import { describe, it, expect } from "vitest";
import {
  deriveGateActivity,
  formatGateDuration,
  GATE_STALL_AFTER_MS,
  type GateActivitySource,
} from "../src/lib/gate-activity.js";

const NOW = Date.parse("2026-08-29T12:00:00.000Z");
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;

/** A running merge job with no attempts yet — the shape right after `startMergeJob`. */
function job(overrides: Partial<GateActivitySource> = {}): GateActivitySource {
  return { state: "running", startedAt: at(0), lastActivityAt: at(0), ...overrides };
}

describe("deriveGateActivity", () => {
  it("returns null when there is no job at all", () => {
    expect(deriveGateActivity(null, NOW)).toBeNull();
    expect(deriveGateActivity(undefined, NOW)).toBeNull();
  });

  it("returns null for a FINISHED job — the board already shows merged/closed or the error", () => {
    // The badge is strictly about work in flight; a lingering one would compete with the
    // real outcome and go stale the moment the process evicted the job.
    for (const state of ["succeeded", "failed"] as const) {
      expect(deriveGateActivity(job({ state, startedAt: at(30 * MIN) }), NOW)).toBeNull();
    }
  });

  it("an in-flight attempt reads as `verifying`, with the attempt's OWN elapsed time", () => {
    const activity = deriveGateActivity(
      job({
        startedAt: at(25 * MIN),
        lastActivityAt: at(18 * MIN),
        attemptCount: 1,
        attempts: [{ attempt: 1, source: "pre-lock-merge", startedAt: at(18 * MIN) }],
      }),
      NOW,
    );
    expect(activity?.phase).toBe("verifying");
    // 18m is how long the SUITE has been running; 25m is how long the merge has. The badge
    // shows the former, because that is the number that predicts when it ends.
    expect(activity?.label).toBe("Verifying · 18m");
    expect(activity?.attempt).toBe(1);
    expect(activity?.elapsedMs).toBe(25 * MIN);
  });

  it("names the attempt number once a merge has retried", () => {
    const activity = deriveGateActivity(
      job({
        startedAt: at(90 * MIN),
        lastActivityAt: at(20 * MIN),
        attemptCount: 2,
        attempts: [
          { attempt: 1, source: "pre-lock-merge", startedAt: at(85 * MIN), finishedAt: at(20 * MIN), outcome: "passed" },
          { attempt: 2, source: "monitor-auto-merge", startedAt: at(20 * MIN) },
        ],
      }),
      NOW,
    );
    expect(activity?.label).toBe("Verifying · attempt 2 · 20m");
    expect(activity?.attemptCount).toBe(2);
  });

  it("surfaces a DISCARDED previous attempt's reason — the #936 fact nothing rendered", () => {
    const activity = deriveGateActivity(
      job({
        startedAt: at(120 * MIN),
        lastActivityAt: at(15 * MIN),
        attemptCount: 2,
        attempts: [
          {
            attempt: 1,
            source: "pre-lock-merge",
            startedAt: at(115 * MIN),
            finishedAt: at(15 * MIN),
            outcome: "discarded",
            detail: "base tip moved during the run",
          },
          { attempt: 2, source: "pre-lock-merge", startedAt: at(15 * MIN) },
        ],
      }),
      NOW,
    );
    expect(activity?.phase).toBe("verifying");
    expect(activity?.detail).toContain("attempt 1 discarded: base tip moved during the run");
  });

  it("does not narrate a PASSED predecessor — an ordinary retry adds nothing to a badge", () => {
    const activity = deriveGateActivity(
      job({
        startedAt: at(60 * MIN),
        lastActivityAt: at(10 * MIN),
        attemptCount: 2,
        attempts: [
          { attempt: 1, source: "pre-lock-merge", startedAt: at(55 * MIN), finishedAt: at(10 * MIN), outcome: "passed" },
          { attempt: 2, source: "pre-lock-merge", startedAt: at(10 * MIN) },
        ],
      }),
      NOW,
    );
    expect(activity?.detail).not.toContain("Previously");
  });

  it("a running job with no attempt in flight reads as `merging`", () => {
    const activity = deriveGateActivity(job({ startedAt: at(2 * MIN), lastActivityAt: at(2 * MIN) }), NOW);
    expect(activity?.phase).toBe("merging");
    expect(activity?.label).toBe("Merging · 2m");
    expect(activity?.attempt).toBeNull();
    expect(activity?.detail).toContain("no gate attempt has begun yet");
  });

  it("goes `stalled` only past the threshold, and only with no attempt outstanding", () => {
    const quiet = (msAgo: number) => job({ startedAt: at(msAgo), lastActivityAt: at(msAgo) });
    expect(deriveGateActivity(quiet(GATE_STALL_AFTER_MS - MIN), NOW)?.phase).toBe("merging");
    expect(deriveGateActivity(quiet(GATE_STALL_AFTER_MS), NOW)?.phase).toBe("stalled");
  });

  it("a long-running attempt is NEVER stalled — a 3h suite is not a hang", () => {
    // This is the asymmetry that keeps #944's badge from repeating #922's mistake: an
    // attempt genuinely in flight is evidence of life, whatever the clock says.
    const activity = deriveGateActivity(
      job({
        startedAt: at(190 * MIN),
        lastActivityAt: at(185 * MIN),
        attemptCount: 1,
        attempts: [{ attempt: 1, source: "pre-lock-merge", startedAt: at(185 * MIN) }],
      }),
      NOW,
    );
    expect(activity?.phase).toBe("verifying");
    expect(activity?.quietMs).toBeGreaterThan(GATE_STALL_AFTER_MS);
  });

  it("falls back to startedAt when lastActivityAt is absent or unparseable", () => {
    expect(deriveGateActivity({ state: "running", startedAt: at(5 * MIN) }, NOW)?.elapsedMs).toBe(5 * MIN);
    const bogus = deriveGateActivity({ state: "running", startedAt: at(5 * MIN), lastActivityAt: "not-a-date" }, NOW);
    expect(bogus?.quietMs).toBe(5 * MIN);
  });

  it("never reports a negative duration when a clock skews forward", () => {
    const activity = deriveGateActivity(job({ startedAt: new Date(NOW + 10 * MIN).toISOString() }), NOW);
    expect(activity?.elapsedMs).toBe(0);
    expect(activity?.quietMs).toBe(0);
  });
});

describe("formatGateDuration", () => {
  it("picks the unit a human would", () => {
    expect(formatGateDuration(45_000)).toBe("45s");
    expect(formatGateDuration(18 * MIN)).toBe("18m");
    expect(formatGateDuration(60 * MIN)).toBe("1h");
    expect(formatGateDuration(192 * MIN)).toBe("3h12m");
  });

  it("degrades to 0s rather than NaN on nonsense input", () => {
    expect(formatGateDuration(Number.NaN)).toBe("0s");
    expect(formatGateDuration(-1)).toBe("0s");
  });
});

describe("#977: the fine-grained gate phase", () => {
  it("a QUEUED attempt does not read as `Verifying` — the case #977 exists for", () => {
    // Same shape as a long-running suite: one attempt, in flight for 40 minutes. The only
    // difference is that nothing is executing, and before #977 the two were the same badge.
    const activity = deriveGateActivity(
      job({
        startedAt: at(41 * MIN),
        lastActivityAt: at(40 * MIN),
        attemptCount: 1,
        attempts: [
          {
            attempt: 1,
            source: "pre-lock-merge",
            startedAt: at(40 * MIN),
            phase: "queued",
            phaseSince: at(40 * MIN),
            phaseDetail: "waiting for the cross-workspace verify chain",
          },
        ],
      }),
      NOW,
    );

    expect(activity?.gatePhase).toBe("queued");
    expect(activity?.label).toBe("Queued · 40m");
    expect(activity?.detail).toContain("waiting for the cross-workspace verify chain");
    // The coarse phase is unchanged, so the badge colour needs no new case.
    expect(activity?.phase).toBe("verifying");
  });

  it("the phase clock counts from `phaseSince`, not from the attempt start", () => {
    // A gate that queued 40 minutes and has been verifying for 2 must read `Verifying · 2m`.
    // Showing the attempt's own age here is what made a queue and a long suite look alike.
    const activity = deriveGateActivity(
      job({
        startedAt: at(43 * MIN),
        lastActivityAt: at(2 * MIN),
        attemptCount: 1,
        attempts: [
          { attempt: 1, source: "pre-lock-merge", startedAt: at(42 * MIN), phase: "verify", phaseSince: at(2 * MIN) },
        ],
      }),
      NOW,
    );

    expect(activity?.label).toBe("Verifying · 2m");
    // The attempt's full age is still in the tooltip — the phase clock narrows the badge, it
    // does not hide how long the attempt has been alive.
    expect(activity?.detail).toContain("running for 42m");
  });

  it("names each remaining phase with its own verb", () => {
    const labelFor = (phase: NonNullable<GateActivitySource["attempts"]>[number]["phase"]) =>
      deriveGateActivity(
        job({
          attemptCount: 1,
          attempts: [{ attempt: 1, source: "pre-lock-merge", startedAt: at(5 * MIN), phase, phaseSince: at(3 * MIN) }],
        }),
        NOW,
      )?.label;

    expect(labelFor("install")).toBe("Installing · 3m");
    expect(labelFor("flake-retry")).toBe("Re-testing · 3m");
    expect(labelFor("smoke")).toBe("Smoke test · 3m");
  });

  it("an attempt that reports NO phase reads exactly as it did before #977", () => {
    // Every gate path outside a merge job records no phases at all, and a job started by an
    // older process has none either. Neither may change what the badge says.
    const activity = deriveGateActivity(
      job({
        startedAt: at(25 * MIN),
        attemptCount: 2,
        attempts: [
          { attempt: 1, source: "pre-lock-merge", startedAt: at(24 * MIN), finishedAt: at(19 * MIN), outcome: "passed" },
          { attempt: 2, source: "merge-executor", startedAt: at(18 * MIN) },
        ],
      }),
      NOW,
    );

    expect(activity?.gatePhase).toBeNull();
    expect(activity?.label).toBe("Verifying · attempt 2 · 18m");
  });
});
