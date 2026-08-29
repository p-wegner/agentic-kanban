/**
 * #935 — a base-health probe that TIMES OUT is a non-answer, not a verdict on the base.
 *
 * The observed failure: every pre-merge gate on this board was stamping
 *   `BASE BRANCH ALREADY TIMEOUT at the branch's merge-base (5bd40054, checked 3h ago)`
 * while a full `pnpm test:mine` on master passed completely (9297 tests, exit 0). The verdicts
 * were produced under machine saturation — Windows Defender at 336% CPU, an unrelated Kotlin
 * daemon at 207%, only 3 vitest workers on the whole box, two runs sitting 20+ minutes without
 * spawning a worker — so the 45-minute budget was not enough and the starved run got cached as
 * the base's health.
 *
 * Two things follow, and both are asserted here:
 *  - a timeout must NOT produce an "ALREADY <outcome>" accusation against the base, and
 *  - merge-gate attribution for a failing branch must be identical to the base-green case, so
 *    the branch is charged for its own failure and #638 routing is unaffected.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Nothing here spawns a probe — the orchestration path is covered by base-branch-health.test.ts.
// Keep it that way: a real clone/install in this file would be the saturation the ticket is about.
vi.mock("@agentic-kanban/shared/lib/setup-script", () => ({
  runSetupScript: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false })),
}));

import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projects } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";
import {
  recordBaseBranchHealth,
  getLatestBaseBranchHealth,
  isBaseHealthAnswer,
} from "../repositories/base-branch-health.repository.js";
import { describeRedBaseAttribution } from "../services/base-branch-health.service.js";
import type { BaseBranchHealthAtMergeBase } from "../services/base-branch-health.service.js";

function healthRow(overrides: Partial<NonNullable<BaseBranchHealthAtMergeBase["health"]>>) {
  return {
    id: "row-1",
    projectId: "p1",
    sha: "5bd400541111111111111111111111111111aaaa",
    branch: "master",
    outcome: "green",
    durationMs: 2_700_000,
    message: null,
    failedSuites: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  } as NonNullable<BaseBranchHealthAtMergeBase["health"]>;
}

describe("isBaseHealthAnswer (#935)", () => {
  it("treats only green and red as verdicts about the base", () => {
    expect(isBaseHealthAnswer("green")).toBe(true);
    expect(isBaseHealthAnswer("red")).toBe(true);
  });

  it("treats timeout and unverified as non-answers", () => {
    // A timeout says the PROBE could not answer inside its budget. An unverified says it never
    // got far enough to install the clone. Neither is evidence about the base.
    expect(isBaseHealthAnswer("timeout")).toBe(false);
    expect(isBaseHealthAnswer("unverified")).toBe(false);
  });

  it("treats an absent or unrecognised outcome as a non-answer", () => {
    expect(isBaseHealthAnswer(null)).toBe(false);
    expect(isBaseHealthAnswer(undefined)).toBe(false);
    expect(isBaseHealthAnswer("something-new")).toBe(false);
  });
});

describe("describeRedBaseAttribution — a timeout yields UNKNOWN, never ALREADY TIMEOUT (#935)", () => {
  it("does not accuse the base when the probe timed out", () => {
    const attribution = describeRedBaseAttribution({
      mergeBaseSha: "5bd400541111111111111111111111111111aaaa",
      health: healthRow({
        outcome: "timeout",
        message: "verify_script timed out after 2700000ms (probe ran 2700123ms with KANBAN_TEST_MAX_WORKERS=4).",
      }),
      recordedSha: "5bd400541111111111111111111111111111aaaa",
      ageMs: 3 * 60 * 60 * 1000,
    });

    expect(attribution).not.toBeNull();
    // The exact string the board was stamping, and the whole point of the ticket.
    expect(attribution).not.toContain("BASE BRANCH ALREADY TIMEOUT");
    expect(attribution).not.toContain("BASE BRANCH ALREADY");
    expect(attribution).toContain("BASE BRANCH HEALTH UNKNOWN");
    expect(attribution).toContain("TIMED OUT");
    // It must say plainly that the branch is not being excused by this.
    expect(attribution).toContain("NOT attributed to it");
  });

  it("still says UNKNOWN (not ALREADY UNVERIFIED) when the clone never installed — #674's case, unchanged", () => {
    const attribution = describeRedBaseAttribution({
      mergeBaseSha: "abc",
      health: healthRow({ outcome: "unverified", message: "could not prepare the base clone" }),
    });
    expect(attribution).toContain("BASE BRANCH HEALTH UNKNOWN");
    expect(attribution).not.toContain("BASE BRANCH ALREADY");
    expect(attribution).toContain("never verified");
  });

  it("still ACCUSES the base when the probe genuinely returned red — the #491 behaviour is intact", () => {
    const attribution = describeRedBaseAttribution({
      mergeBaseSha: "5bd400541111111111111111111111111111aaaa",
      health: healthRow({ outcome: "red", message: "Tests 1 failed | 1035 passed" }),
      recordedSha: "5bd400541111111111111111111111111111aaaa",
    });
    expect(attribution).toContain("BASE BRANCH ALREADY RED");
    expect(attribution).toContain("Tests 1 failed");
  });

  it("returns null for a green base, as before", () => {
    expect(describeRedBaseAttribution({ mergeBaseSha: "abc", health: healthRow({ outcome: "green" }) })).toBeNull();
  });
});

describe("merge-gate attribution for a failing branch is unchanged between a timed-out base and a green base (#935)", () => {
  /**
   * The acceptance criterion stated as an equality rather than as two separate assertions: a
   * timed-out base must leave the branch's own gate failure exactly as a green base does —
   * unexcused. If these two ever diverge, a starved probe is once again changing behaviour.
   */
  it("produces no ALREADY-attribution in either case", () => {
    const timedOut = describeRedBaseAttribution({
      mergeBaseSha: "base-tip",
      health: healthRow({ outcome: "timeout", message: "verify_script timed out after 2700000ms" }),
    });
    const green = describeRedBaseAttribution({
      mergeBaseSha: "base-tip",
      health: healthRow({ outcome: "green" }),
    });

    // Green attributes nothing at all; the timeout attributes nothing TO THE BASE. What the
    // timeout adds is an explicit disclaimer, which is strictly more honest than silence — but
    // neither may carry the accusation that suppresses #638 routing and excuses the branch.
    expect(green).toBeNull();
    expect(timedOut).not.toContain("BASE BRANCH ALREADY");
    expect(timedOut).not.toContain("may not be caused by this branch");
  });
});

describe("a timeout row records provenance so a starved probe is legible (#935)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db } = createTestDb());
  });

  it("round-trips the timeout message including budget and worker cap", async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "ak-935-repo-"));
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    const now = new Date().toISOString();
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      name: "p",
      repoPath,
      repoName: "repo",
      defaultBranch: "master",
      createdAt: now,
      updatedAt: now,
    });

    await recordBaseBranchHealth(
      {
        projectId,
        sha: "5bd40054",
        branch: "master",
        outcome: "timeout",
        durationMs: 2_700_123,
        message:
          "verify_script timed out after 2700000ms (probe ran 2700123ms with KANBAN_TEST_MAX_WORKERS=4). "
          + "This is NOT a verdict about the base: the probe could not answer, so the base's health is UNKNOWN.",
        // A timeout learns nothing per-suite, so the list must stay null (#681's rule).
        failedSuites: null,
      },
      db,
    );

    const latest = await getLatestBaseBranchHealth(projectId, db);
    expect(latest?.outcome).toBe("timeout");
    expect(latest?.message).toContain("KANBAN_TEST_MAX_WORKERS=4");
    expect(latest?.message).toContain("UNKNOWN");
    // null, not "[]" — "the probe named no failures" would be a claim it never made.
    expect(latest?.failedSuites).toBeNull();
  });
});

describe("the red-debt subset rule cannot be softened by a timed-out probe (#935)", () => {
  it("a timeout never produces a failed-suite list", async () => {
    const { failedSuitesForOutcome } = await import("../services/failed-suite-parse.js");
    // Even when the cut-off output happens to contain suite-looking lines, a timeout may not
    // name failures: everything after the cut is unjudged. This is what keeps a starved probe
    // out of the #915 softening path, which opens red-debt entries from that list.
    expect(
      failedSuitesForOutcome("timeout", "FAIL packages/server/src/__tests__/a.test.ts\nTests 1 failed"),
    ).toBeNull();
  });
});
