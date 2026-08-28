/**
 * #712 — the base-health probe used ONE deterministic temp dir and had no in-flight guard.
 *
 * `join(tmpdir(), \`kanban-base-health-${projectId}-${slug}\`)` was the same path on every call,
 * `rm -rf`'d before the clone and again in `finally`. Two callers exist and neither knew about
 * the other — the periodic sweep, and a fire-and-forget probe after EVERY merge — so probe B
 * wiped probe A's tree mid-verify and A's `finally` deleted B's. The outer catch recorded the
 * wreck as `outcome: "red"`: a false red that withholds merges board-wide, and a strong
 * candidate for this repo's own "200 probes, 199 red, 0 green" figure.
 *
 * The four properties pinned here are the four defects:
 *   1. two probes never share a directory,
 *   2. a probe in flight makes the sweep skip (across a process restart, so persisted),
 *   3. a timing-out probe is not immediately due again, and
 *   4. a future `createdAt` does not wedge the sweep.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projects } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";

const runSetupScript = vi.fn();
vi.mock("@agentic-kanban/shared/lib/setup-script", () => ({
  runSetupScript: (...args: unknown[]) => runSetupScript(...args),
}));

/** Every clone destination the probe asked for, in call order. */
const cloneDests: string[] = [];
const cloneBranchTo = vi.fn(async (_repo: string, _branch: string, dest: string) => {
  cloneDests.push(dest);
  mkdirSync(dest, { recursive: true });
});
vi.mock("@agentic-kanban/shared/lib/git-service", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    cloneBranchTo: (...args: [string, string, string]) => cloneBranchTo(...args),
    revParse: async () => "abc1234",
  };
});

const {
  verifyBaseBranchHealth,
  baseHealthProbeStartPrefKey,
  inFlightBaseBranchProbeCount,
  PROBE_MAX_DURATION_MS,
} = await import("../services/base-branch-health.service.js");
const { isBaseHealthProbeDue } = await import("../startup/base-branch-health-reconciler.js");
const { setPreference, getPreference } = await import("../repositories/preferences.repository.js");
const { verifyScriptPrefKey } = await import("../services/stack-profile.service.js");
const { recordBaseBranchHealth } = await import("../repositories/base-branch-health.repository.js");

const tempRepos: string[] = [];
function makeRepoPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "ak-base-health-conc-repo-"));
  mkdirSync(join(dir, ".git"), { recursive: true });
  tempRepos.push(dir);
  return dir;
}

async function seedProject(db: ReturnType<typeof createTestDb>["db"]) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId,
    name: "Concurrency Project",
    repoPath: makeRepoPath(),
    repoName: "repo",
    defaultBranch: "master",
    createdAt: now,
    updatedAt: now,
  });
  // No stack profile ⇒ no install command, so the probe goes straight to verify.
  await setPreference(verifyScriptPrefKey(projectId), "pnpm test", db);
  return projectId;
}

afterEach(() => {
  while (tempRepos.length) {
    try { rmSync(tempRepos.pop()!, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe("base-health probes do not collide on one temp dir (#712)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    vi.clearAllMocks();
    cloneDests.length = 0;
    ({ db } = createTestDb());
    runSetupScript.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "", timedOut: false });
  });

  it("gives each probe of the SAME project a distinct directory", async () => {
    const projectId = await seedProject(db);

    await verifyBaseBranchHealth(projectId, db);
    await verifyBaseBranchHealth(projectId, db);

    expect(cloneDests).toHaveLength(2);
    // The old code produced the identical path twice — which is what let one probe delete the
    // other's tree. Uniqueness is the property, not the specific naming scheme.
    expect(cloneDests[0]).not.toBe(cloneDests[1]);
    expect(new Set(cloneDests).size).toBe(2);
  });

  it("removes only its OWN directory, so a sibling probe's tree survives", async () => {
    const projectId = await seedProject(db);

    // Probe A parks inside verify; while it is parked, probe B for the SAME project runs to
    // completion. Under the old deterministic path, B's `rm` erased A's clone here.
    let releaseA: () => void = () => {};
    const aParked = new Promise<void>((resolve) => { releaseA = resolve; });
    let aDirExistedAfterB = false;

    runSetupScript.mockImplementationOnce(async (cwd: string) => {
      await aParked;
      aDirExistedAfterB = existsSync(cwd);
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    });

    // Bypass the in-flight coalescer the way two PROCESSES would: distinct project rows over
    // the same repo. The directory property must hold without the lock.
    const otherProjectId = await seedProject(db);

    const probeA = verifyBaseBranchHealth(projectId, db);
    await vi.waitFor(() => expect(cloneDests).toHaveLength(1));

    await verifyBaseBranchHealth(otherProjectId, db);
    releaseA();
    await probeA;

    expect(aDirExistedAfterB).toBe(true);
  });

  it("coalesces concurrent probes for one project into a single run", async () => {
    const projectId = await seedProject(db);

    let release: () => void = () => {};
    const parked = new Promise<void>((resolve) => { release = resolve; });
    runSetupScript.mockImplementationOnce(async () => {
      await parked;
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    });

    const first = verifyBaseBranchHealth(projectId, db);
    await vi.waitFor(() => expect(inFlightBaseBranchProbeCount()).toBe(1));
    const second = verifyBaseBranchHealth(projectId, db);

    release();
    const [a, b] = await Promise.all([first, second]);

    expect(cloneDests).toHaveLength(1);
    expect(a).toEqual(b);
    expect(inFlightBaseBranchProbeCount()).toBe(0);
  });

  it("persists a start stamp for the duration of the probe and clears it after", async () => {
    const projectId = await seedProject(db);
    const key = baseHealthProbeStartPrefKey(projectId);

    let release: () => void = () => {};
    const parked = new Promise<void>((resolve) => { release = resolve; });
    let stampWhileRunning: string | null = null;
    runSetupScript.mockImplementationOnce(async () => {
      stampWhileRunning = await getPreference(key, db);
      await parked;
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    });

    const probe = verifyBaseBranchHealth(projectId, db, "2026-08-22T10:00:00.000Z");
    await vi.waitFor(() => expect(stampWhileRunning).not.toBeNull());
    release();
    await probe;

    expect(stampWhileRunning).toBe("2026-08-22T10:00:00.000Z");
    expect(await getPreference(key, db)).toBe("");
  });
});

describe("isBaseHealthProbeDue (#712)", () => {
  const INTERVAL_MS = 30 * 60 * 1000;
  const nowMs = Date.parse("2026-08-22T12:00:00.000Z");
  const iso = (offsetMs: number) => new Date(nowMs + offsetMs).toISOString();

  it("is due when the project has no history", () => {
    expect(isBaseHealthProbeDue({ nowMs, intervalMs: INTERVAL_MS })).toEqual({
      due: true,
      reason: "no_history",
    });
  });

  it("skips while a probe is in flight — the restart-storm case the end-stamp missed", () => {
    // A probe started 5 minutes ago is still running; the persisted RESULT is an hour old, so
    // the old recency check said "due" and launched a rival verify on every restart.
    const verdict = isBaseHealthProbeDue({
      nowMs,
      intervalMs: INTERVAL_MS,
      lastResultAt: iso(-60 * 60 * 1000),
      lastOutcome: "green",
      probeStartedAt: iso(-5 * 60 * 1000),
    });
    expect(verdict).toEqual({ due: false, reason: "probe_in_flight" });
  });

  it("treats a start stamp older than the probe ceiling as an abandoned run, not a lock", () => {
    const verdict = isBaseHealthProbeDue({
      nowMs,
      intervalMs: INTERVAL_MS,
      lastResultAt: iso(-60 * 60 * 1000),
      probeStartedAt: iso(-(PROBE_MAX_DURATION_MS + 1000)),
    });
    expect(verdict.due).toBe(true);
  });

  it("ignores an empty start stamp (the cleared value)", () => {
    const verdict = isBaseHealthProbeDue({
      nowMs,
      intervalMs: INTERVAL_MS,
      lastResultAt: iso(-60 * 60 * 1000),
      probeStartedAt: "",
    });
    expect(verdict.due).toBe(true);
  });

  it("does not make a timing-out probe due again one interval later", () => {
    // The interval (30 min) is SHORTER than the verify ceiling (45 min), so with no outcome
    // filter a permanently-timing-out project was due the moment it stopped timing out — i.e.
    // it ran continuously.
    const soonAfterTimeout = isBaseHealthProbeDue({
      nowMs,
      intervalMs: INTERVAL_MS,
      lastResultAt: iso(-(INTERVAL_MS + 60 * 1000)),
      lastOutcome: "timeout",
    });
    expect(soonAfterTimeout).toEqual({ due: false, reason: "recent_result" });

    // A red result at the same age IS due — the back-off is specific to `timeout`.
    const red = isBaseHealthProbeDue({
      nowMs,
      intervalMs: INTERVAL_MS,
      lastResultAt: iso(-(INTERVAL_MS + 60 * 1000)),
      lastOutcome: "red",
    });
    expect(red.due).toBe(true);

    // And a timeout does become due once the longer back-off elapses.
    const later = isBaseHealthProbeDue({
      nowMs,
      intervalMs: INTERVAL_MS,
      lastResultAt: iso(-(INTERVAL_MS + PROBE_MAX_DURATION_MS + 1000)),
      lastOutcome: "timeout",
    });
    expect(later.due).toBe(true);
  });

  it("does not wedge on a FUTURE createdAt", () => {
    // `nowMs - lastMs` was negative, which is always "< intervalMs", so the sweep went
    // silently dead for that project until wall-clock caught up.
    const verdict = isBaseHealthProbeDue({
      nowMs,
      intervalMs: INTERVAL_MS,
      lastResultAt: iso(24 * 60 * 60 * 1000),
      lastOutcome: "green",
    });
    expect(verdict).toEqual({ due: true, reason: "interval_elapsed" });
  });

  it("does not treat a FUTURE start stamp as a probe in flight", () => {
    const verdict = isBaseHealthProbeDue({
      nowMs,
      intervalMs: INTERVAL_MS,
      lastResultAt: iso(-60 * 60 * 1000),
      probeStartedAt: iso(60 * 60 * 1000),
    });
    expect(verdict.due).toBe(true);
  });

  it("defers to a running merge gate even when otherwise due (#931)", () => {
    const verdict = isBaseHealthProbeDue({
      nowMs,
      intervalMs: INTERVAL_MS,
      lastResultAt: iso(-60 * 60 * 1000),
      lastOutcome: "green",
      gateBusy: true,
    });
    expect(verdict).toEqual({ due: false, reason: "gate_running" });
  });

  it("with no history AND a busy gate, still defers rather than probing anyway (#931)", () => {
    const verdict = isBaseHealthProbeDue({ nowMs, intervalMs: INTERVAL_MS, gateBusy: true });
    expect(verdict).toEqual({ due: false, reason: "gate_running" });
  });

  it("runs normally once the gate is no longer busy", () => {
    const verdict = isBaseHealthProbeDue({
      nowMs,
      intervalMs: INTERVAL_MS,
      lastResultAt: iso(-60 * 60 * 1000),
      lastOutcome: "green",
      gateBusy: false,
    });
    expect(verdict).toEqual({ due: true, reason: "interval_elapsed" });
  });
});

describe("the sweep honours an in-flight probe (#712)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    vi.clearAllMocks();
    cloneDests.length = 0;
    ({ db } = createTestDb());
    runSetupScript.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "", timedOut: false });
  });

  it("skips a project whose start stamp says a probe is still running", async () => {
    const { runBaseBranchHealthCheckOnce } = await import("../startup/base-branch-health-reconciler.js");
    const projectId = await seedProject(db);

    // A RESULT older than one interval (so the old recency gate would have said "due") plus a
    // live start stamp: a fresh process after a `tsx watch` restart mid-probe.
    const nowMs = Date.now();
    await recordBaseBranchHealth(
      { projectId, sha: "abc1234", branch: "master", outcome: "green" },
      db,
    );
    await setPreference(baseHealthProbeStartPrefKey(projectId), new Date(nowMs).toISOString(), db);

    // 40 minutes later: past the 30-minute interval (so the result-recency gate alone would
    // say "due"), but well inside the probe's own 65-minute ceiling — it is still running.
    await runBaseBranchHealthCheckOnce(db, 30 * 60 * 1000, nowMs + 40 * 60 * 1000);

    expect(cloneDests).toHaveLength(0);
  });

  it("does not start a probe while a merge gate holds the build semaphore (#931)", async () => {
    const { runBaseBranchHealthCheckOnce } = await import("../startup/base-branch-health-reconciler.js");
    const { runUnderBuildSemaphore } = await import("../services/jvm-build-semaphore.js");
    const projectId = await seedProject(db);

    // Otherwise clearly due: no history at all.
    let releaseGate: () => void = () => {};
    const gateHeld = new Promise<void>((resolve) => { releaseGate = resolve; });
    const gateTask = runUnderBuildSemaphore(() => gateHeld);

    await runBaseBranchHealthCheckOnce(db, 30 * 60 * 1000, Date.now());
    expect(cloneDests).toHaveLength(0);

    releaseGate();
    await gateTask;

    // Once the gate releases the semaphore, the probe runs on the next tick.
    await runBaseBranchHealthCheckOnce(db, 30 * 60 * 1000, Date.now());
    expect(cloneDests).toHaveLength(1);
  });
});
