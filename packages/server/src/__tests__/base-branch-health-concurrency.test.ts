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
const { isBaseHealthProbeDue } = await import("../services/base-branch-health-reprobe.service.js");
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
  // #983 — the sweep is opt-in, so a project with no explicit posture is never probed. Every
  // case here is about the CONCURRENCY guards, which only matter for a project that opted in.
  // `standard`'s `sweepIntervalMs` is the same 30 minutes these tests already pass.
  await setPreference(`risk_posture_${projectId}`, "standard", db);
  return projectId;
}

afterEach(async () => {
  while (tempRepos.length) {
    try { rmSync(tempRepos.pop()!, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  // #949: the probe's verify now takes the process-global verify-chain slot. Several tests here
  // park a probe inside `runSetupScript` and release it late (or not at all), so without this a
  // held slot leaks into the NEXT test and every later probe queues behind a chain that will
  // never finish — the whole file then times out one test at a time.
  const { resetVerifyChainSemaphoreForTests } = await import("../services/verify-chain-semaphore.js");
  resetVerifyChainSemaphoreForTests();
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

    // Probe A parks inside verify; probe B for a DIFFERENT project then runs. Under the old
    // deterministic path, B's `rm` erased A's clone here.
    //
    // #949 note: A and B no longer OVERLAP — the verify-chain semaphore serializes them, which
    // is the whole point of that ticket (two full suites on one box is the symptom regardless of
    // which project each belongs to). So B is started only after A has finished its verify and
    // released the slot. The property under test is unchanged and is if anything now stated more
    // precisely: A's directory must survive B's `finally`, whether or not the two overlapped in
    // time. Sequencing them also keeps this test from deadlocking on the shared slot.
    let releaseA: () => void = () => {};
    const aParked = new Promise<void>((resolve) => { releaseA = resolve; });
    let aDir = "";

    runSetupScript.mockImplementationOnce(async (cwd: string) => {
      aDir = cwd;
      await aParked;
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    });

    // Distinct project rows over the same repo — the way two PROCESSES would bypass the
    // per-project in-flight coalescer.
    const otherProjectId = await seedProject(db);

    const probeA = verifyBaseBranchHealth(projectId, db);
    await vi.waitFor(() => expect(cloneDests).toHaveLength(1));

    releaseA();
    await probeA;
    // A has finished; its directory is gone by its own `finally`. Capture that B does not go
    // looking for it — the collision this test exists for was B deleting a path A still held.
    await verifyBaseBranchHealth(otherProjectId, db);

    expect(cloneDests).toHaveLength(2);
    expect(cloneDests[0]).not.toBe(cloneDests[1]);
    // B's clone destination is its own, not the one A used.
    expect(cloneDests[1]).not.toBe(aDir);
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

/**
 * #949 — #931's protection was ONE-DIRECTIONAL, and that is the residual hole.
 *
 * #931 made the base-health SCHEDULER decline to start a probe while a gate held the build
 * semaphore. But nothing stopped the reverse: once a probe was already running, a gate arriving
 * afterwards took its verify-chain slot immediately and ran a second full suite alongside it.
 * "Two full suites on one box" is the #949 symptom regardless of which one started first, and a
 * shared worker cap (#931's other half) does not help when there are two of everything.
 *
 * The fix is that the probe's verify run now takes the SAME one-at-a-time chain slot the gate's
 * verify chain takes, so the property belongs to the box rather than to one code path.
 */
describe("a running base-health probe holds the verify-chain slot against a later gate (#949)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    vi.clearAllMocks();
    cloneDests.length = 0;
    ({ db } = createTestDb());
  });

  it("makes a gate's verify chain WAIT instead of running a second full suite concurrently", async () => {
    const { runUnderVerifyChainSemaphore, resetVerifyChainSemaphoreForTests, verifyChainSemaphoreQueueLength } =
      await import("../services/verify-chain-semaphore.js");
    resetVerifyChainSemaphoreForTests();

    const projectId = await seedProject(db);
    await setPreference(verifyScriptPrefKey(projectId), "pnpm test", db);

    // Hold the probe's verify_script open so the probe is demonstrably mid-run.
    let releaseProbe: () => void = () => {};
    const probeRunning = new Promise<void>((resolve) => { releaseProbe = resolve; });
    let probeStarted: () => void = () => {};
    const probeHasStarted = new Promise<void>((resolve) => { probeStarted = resolve; });
    runSetupScript.mockImplementation(async () => {
      probeStarted();
      await probeRunning;
      return { exitCode: 0, stdout: "ok", stderr: "", timedOut: false };
    });

    const probe = verifyBaseBranchHealth(projectId, db);
    await probeHasStarted;

    // A gate's verify chain arrives while the probe is mid-suite.
    const gateRan = { value: false };
    const gate = runUnderVerifyChainSemaphore(async () => { gateRan.value = true; }, "gate");
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The crux: the gate is QUEUED, not running a second full suite next to the probe.
    expect(gateRan.value).toBe(false);
    expect(verifyChainSemaphoreQueueLength()).toBe(1);

    releaseProbe();
    await probe;
    await gate;
    // ...and it does run, promptly, once the probe frees the box. Queued, never dropped.
    expect(gateRan.value).toBe(true);

    resetVerifyChainSemaphoreForTests();
  }, 30000);
});

/**
 * #989 — the other half of #978, and the direct continuation of the test above.
 *
 * That one pins the property #949 bought: a gate arriving during a probe QUEUES rather than
 * running a second full suite. Correct, and still the point — but it is also the whole cost: the
 * probe can hold the slot for clone 5m + install 15m + verify 45m, so the gate's correct queueing
 * was measured at ~35 minutes on #971's merge. #978's priority classes do not help, because they
 * only decide who is admitted NEXT.
 *
 * The yield therefore has to be MID-VERIFY, and that is the only place it can be. The probe's
 * clone and install run OUTSIDE the slot — they hold nothing, so a gate arriving then acquires
 * the slot immediately and waits zero, and `verifyChainGateWaiting()` is false there by
 * construction. Only while the verify child runs is the probe both holding what the gate wants
 * and able to see the gate queued behind it. So the probe polls while it verifies, and kills its
 * own child when a gate-class waiter appears.
 *
 * Every test below therefore drives the REAL shape: the probe's own verify holds the slot, and a
 * gate queues behind it. (An earlier draft manufactured a three-party state with a synthetic
 * holder chain, which is a configuration where yielding frees nothing the gate needs — the tests
 * passed and the feature could not fire.)
 */
describe("a running base-health probe YIELDS the verify slot to a waiting gate (#989)", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  /**
   * The poll cadence these tests run at. The production default is 15s, which would make every
   * case below a 15-second wait; the override exists so a real abort can be driven in ms without
   * fake timers (this code also awaits real promises, and mixing the two is how a test ends up
   * asserting the mock rather than the mechanism). Waits below use a multiple of it.
   */
  const PROBE_GATE_POLL_INTERVAL_MS_TEST = 60;

  beforeEach(async () => {
    vi.clearAllMocks();
    cloneDests.length = 0;
    ({ db } = createTestDb());
    process.env.KANBAN_BASE_HEALTH_GATE_POLL_MS = String(PROBE_GATE_POLL_INTERVAL_MS_TEST / 3);
    // These yields happen in milliseconds, so the 60s streak floor would make every one of them
    // free and the streak assertions vacuous. Floor off by default here; the ONE test that is
    // about the floor sets it explicitly.
    process.env.KANBAN_BASE_HEALTH_YIELD_STREAK_FLOOR_MS = "0";
    const { resetProbeYieldStreaksForTests } = await import("../services/base-health-probe-preemption.js");
    resetProbeYieldStreaksForTests();
    const { resetVerifyChainSemaphoreForTests } = await import("../services/verify-chain-semaphore.js");
    resetVerifyChainSemaphoreForTests();
  });
  afterEach(async () => {
    const { resetProbeYieldStreaksForTests } = await import("../services/base-health-probe-preemption.js");
    resetProbeYieldStreaksForTests();
    delete process.env.KANBAN_BASE_HEALTH_MAX_CONSECUTIVE_YIELDS;
    delete process.env.KANBAN_BASE_HEALTH_GATE_POLL_MS;
    delete process.env.KANBAN_BASE_HEALTH_YIELD_STREAK_FLOOR_MS;
  });

  /**
   * Stand in for the real `runSetupScript` verify child: a long-running process that only ends
   * when its `signal` aborts, resolving with `aborted: true` exactly as the shared adapter does.
   * This is what makes the probe's verify actually HOLD the slot for the duration, which is the
   * state the whole feature is about.
   *
   * `onRunning` fires once the child is "spawned", so a test can queue its gate at a moment when
   * the probe is demonstrably mid-verify rather than racing it.
   */
  function mockAbortableVerify(onRunning?: () => void) {
    runSetupScript.mockImplementation((_cwd: string, _script: string, opts?: { signal?: AbortSignal }) =>
      new Promise((resolve) => {
        const signal = opts?.signal;
        if (!signal) return resolve({ exitCode: 0, stdout: "ok", stderr: "", timedOut: false });
        signal.addEventListener(
          "abort",
          () => resolve({ exitCode: 130, stdout: "", stderr: "", aborted: true }),
          { once: true },
        );
        onRunning?.();
      }),
    );
  }

  /** Queue a real `gate`-class chain and wait until the semaphore reports it as waiting. */
  async function queueGate(): Promise<{ ran: () => boolean; done: Promise<unknown> }> {
    const { runUnderVerifyChainSemaphore, verifyChainGateWaiting } =
      await import("../services/verify-chain-semaphore.js");
    let ran = false;
    const done = runUnderVerifyChainSemaphore(async () => { ran = true; return "gate ran"; }, "a merge gate");
    await vi.waitFor(() => expect(verifyChainGateWaiting()).toBe(true));
    return { ran: () => ran, done };
  }

  /**
   * THE headline test — the whole ticket in one case, and the one the previous draft could not
   * express. The probe's OWN verify holds the slot; a gate queues behind it; the probe kills its
   * child and the gate runs, all while the probe's verify would still have been going.
   *
   * That last clause is the property #971 measured. Without it the test would pass on a probe
   * that merely finished quickly.
   */
  it("kills its own running verify so the gate's chain runs BEFORE that verify would have finished", async () => {
    const { getLatestBaseBranchHealth } = await import("../repositories/base-branch-health.repository.js");
    const { probeConsecutiveYields } = await import("../services/base-health-probe-preemption.js");
    const projectId = await seedProject(db);

    // The verify child never ends on its own — it only ends by abort. So if the gate runs at all,
    // it can only be because the probe gave the slot up mid-run.
    let verifyRunning: () => void = () => {};
    const verifyHasStarted = new Promise<void>((resolve) => { verifyRunning = resolve; });
    mockAbortableVerify(() => verifyRunning());

    const probe = verifyBaseBranchHealth(projectId, db);
    await verifyHasStarted;

    const gate = await queueGate();
    // Pinned: the gate is genuinely blocked on the probe at this instant.
    expect(gate.ran()).toBe(false);

    const result = await probe;
    await gate.done;

    // The gate got the box — from a verify that had not finished and never would have.
    expect(gate.ran()).toBe(true);
    // ...and the probe recorded NOTHING. Inventing an `aborted` outcome would have to be learned
    // by the rot detector, the attribution path and #978's sha cache alike, for a run that
    // observed nothing.
    expect(result).toBeNull();
    expect(await getLatestBaseBranchHealth(projectId, db)).toBeFalsy();
    // Counted, so a repeatedly-preempted probe is visible rather than silently absent.
    expect(probeConsecutiveYields(projectId)).toBe(1);
  }, 30000);

  it("clears the in-flight start stamp on the way out, so the next sweep is not blocked by a run that ended", async () => {
    const projectId = await seedProject(db);
    let verifyRunning: () => void = () => {};
    const verifyHasStarted = new Promise<void>((resolve) => { verifyRunning = resolve; });
    mockAbortableVerify(() => verifyRunning());

    const probe = verifyBaseBranchHealth(projectId, db);
    await verifyHasStarted;
    const gate = await queueGate();
    await probe;
    await gate.done;

    // The `finally` runs on the yield path too — otherwise a yielded probe would look in-flight
    // for its full 65-minute ceiling and `isBaseHealthProbeDue` would report `probe_in_flight`.
    expect(await getPreference(baseHealthProbeStartPrefKey(projectId), db)).toBe("");
    expect(inFlightBaseBranchProbeCount()).toBe(0);
  }, 30000);

  it("runs to completion once the consecutive-yield bound is spent — the anti-thrash escape", async () => {
    const { probeConsecutiveYields } = await import("../services/base-health-probe-preemption.js");
    const projectId = await seedProject(db);
    // A bound of 1 keeps this to two probes; the mechanism is the same at the default 3.
    process.env.KANBAN_BASE_HEALTH_MAX_CONSECUTIVE_YIELDS = "1";

    // Probe 1 yields, spending the budget.
    let verifyRunning: () => void = () => {};
    let verifyHasStarted = new Promise<void>((resolve) => { verifyRunning = resolve; });
    mockAbortableVerify(() => verifyRunning());
    const first = verifyBaseBranchHealth(projectId, db);
    await verifyHasStarted;
    const gate1 = await queueGate();
    expect(await first).toBeNull();
    await gate1.done;
    expect(probeConsecutiveYields(projectId)).toBe(1);

    // Probe 2: a gate is STILL queued, but a board merging steadily must not preempt every probe
    // forever — the same starvation #978's priority classes needed a bound for. This one must
    // survive the waiting gate and produce a verdict.
    verifyHasStarted = new Promise<void>((resolve) => { verifyRunning = resolve; });
    let finishVerify: () => void = () => {};
    runSetupScript.mockImplementation((_cwd: string, _script: string, opts?: { signal?: AbortSignal }) =>
      new Promise((resolve) => {
        finishVerify = () => resolve({ exitCode: 0, stdout: "ok", stderr: "", timedOut: false });
        opts?.signal?.addEventListener(
          "abort",
          () => resolve({ exitCode: 130, stdout: "", stderr: "", aborted: true }),
          { once: true },
        );
        verifyRunning();
      }),
    );
    const second = verifyBaseBranchHealth(projectId, db);
    await verifyHasStarted;
    const gate2 = await queueGate();

    // Give the poll room to fire and NOT abort — the escape is what keeps this verify alive.
    await new Promise((r) => setTimeout(r, PROBE_GATE_POLL_INTERVAL_MS_TEST));
    finishVerify();

    const result = await second;
    await gate2.done;
    expect(result?.outcome).toBe("green");
    // ...and a completed run ends the streak, so the next gate can preempt again.
    expect(probeConsecutiveYields(projectId)).toBe(0);
  }, 30000);

  it("never yields when the bound is 0 — preemption off, and silently so", async () => {
    const { probeConsecutiveYields } = await import("../services/base-health-probe-preemption.js");
    const projectId = await seedProject(db);
    process.env.KANBAN_BASE_HEALTH_MAX_CONSECUTIVE_YIELDS = "0";

    const logged: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      logged.push(String(msg));
    });
    try {
      let verifyRunning: () => void = () => {};
      const verifyHasStarted = new Promise<void>((resolve) => { verifyRunning = resolve; });
      let finishVerify: () => void = () => {};
      runSetupScript.mockImplementation((_cwd: string, _script: string, opts?: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          finishVerify = () => resolve({ exitCode: 0, stdout: "ok", stderr: "", timedOut: false });
          opts?.signal?.addEventListener(
            "abort",
            () => resolve({ exitCode: 130, stdout: "", stderr: "", aborted: true }),
            { once: true },
          );
          verifyRunning();
        }),
      );

      const probe = verifyBaseBranchHealth(projectId, db);
      await verifyHasStarted;
      const gate = await queueGate();
      await new Promise((r) => setTimeout(r, PROBE_GATE_POLL_INTERVAL_MS_TEST));
      finishVerify();

      const result = await probe;
      await gate.done;

      expect(result?.outcome).toBe("green");
      expect(probeConsecutiveYields(projectId)).toBe(0);
      // `disabled` is a configuration fact, not a gate being made to wait — so no escape-hatch
      // line. Collapsing it into `yield_budget_exhausted` logged "already yielded 0 time(s)",
      // which is both untrue and alarming.
      expect(logged.filter((l) => l.includes("is NOT yielding"))).toHaveLength(0);
    } finally {
      logSpy.mockRestore();
    }
  }, 30000);

  it("a yield that discards almost no verify still aborts, but costs no streak budget", async () => {
    const { getLatestBaseBranchHealth } = await import("../repositories/base-branch-health.repository.js");
    const { probeConsecutiveYields } = await import("../services/base-health-probe-preemption.js");
    const projectId = await seedProject(db);
    // The real 60s floor against a yield that fires in milliseconds. Without it, three cheap
    // yields in a merge train exhaust the budget and force the probe to run to completion DURING
    // the train — the outcome the bound exists to avoid, reached from the other side.
    process.env.KANBAN_BASE_HEALTH_YIELD_STREAK_FLOOR_MS = "60000";

    let verifyRunning: () => void = () => {};
    const verifyHasStarted = new Promise<void>((resolve) => { verifyRunning = resolve; });
    mockAbortableVerify(() => verifyRunning());

    const probe = verifyBaseBranchHealth(projectId, db);
    await verifyHasStarted;
    const gate = await queueGate();

    const result = await probe;
    await gate.done;

    // It DID yield — the gate got the box and nothing was recorded...
    expect(gate.ran()).toBe(true);
    expect(result).toBeNull();
    expect(await getLatestBaseBranchHealth(projectId, db)).toBeFalsy();
    // ...but it threw away ~nothing, so the escape budget is untouched.
    expect(probeConsecutiveYields(projectId)).toBe(0);
  }, 30000);

  it("clears the streak when a run ERRORS into a verdict, not only when it succeeds", async () => {
    const { probeConsecutiveYields, recordProbeYield } =
      await import("../services/base-health-probe-preemption.js");
    const projectId = await seedProject(db);

    // Pre-load a streak, as two earlier yields would have.
    recordProbeYield(projectId);
    recordProbeYield(projectId);
    expect(probeConsecutiveYields(projectId)).toBe(2);

    // A throwing verify lands in the outer catch as `red` — a completed run by any reading, since
    // it produced a recorded verdict. "Consecutive" must not survive it.
    runSetupScript.mockRejectedValue(new Error("verify blew up"));
    const result = await verifyBaseBranchHealth(projectId, db);

    expect(result?.outcome).toBe("red");
    expect(probeConsecutiveYields(projectId)).toBe(0);
  }, 30000);

  it("does not yield to a gate that is ACTIVE rather than waiting — there is nothing to give up", async () => {
    const { runUnderVerifyChainSemaphore } = await import("../services/verify-chain-semaphore.js");
    const { probeConsecutiveYields } = await import("../services/base-health-probe-preemption.js");
    const projectId = await seedProject(db);

    // A gate HOLDING the slot is the opposite case: it is not queued, so `verifyChainGateWaiting()`
    // is false, and the probe has nothing to yield — it simply queues behind it as a background
    // chain, which is #978's behaviour and must be left intact.
    let releaseGate: () => void = () => {};
    const gateHeld = new Promise<void>((resolve) => { releaseGate = resolve; });
    const gate = runUnderVerifyChainSemaphore(async () => { await gateHeld; }, "an active gate");
    await new Promise((r) => setTimeout(r, 20));

    runSetupScript.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "", timedOut: false });
    const probe = verifyBaseBranchHealth(projectId, db);
    // It clones (that stage holds no slot) and then queues for the verify slot.
    await vi.waitFor(() => expect(cloneDests).toHaveLength(1));

    releaseGate();
    const result = await probe;
    await gate;

    expect(result?.outcome).toBe("green");
    expect(probeConsecutiveYields(projectId)).toBe(0);
  }, 30000);

  it("does not yield when only a BACKGROUND chain is queued — a probe does not preempt a probe", async () => {
    const { runUnderVerifyChainSemaphore } = await import("../services/verify-chain-semaphore.js");
    const { probeConsecutiveYields } = await import("../services/base-health-probe-preemption.js");
    const projectId = await seedProject(db);

    let verifyRunning: () => void = () => {};
    const verifyHasStarted = new Promise<void>((resolve) => { verifyRunning = resolve; });
    let finishVerify: () => void = () => {};
    runSetupScript.mockImplementation((_cwd: string, _script: string, opts?: { signal?: AbortSignal }) =>
      new Promise((resolve) => {
        finishVerify = () => resolve({ exitCode: 0, stdout: "ok", stderr: "", timedOut: false });
        opts?.signal?.addEventListener(
          "abort",
          () => resolve({ exitCode: 130, stdout: "", stderr: "", aborted: true }),
          { once: true },
        );
        verifyRunning();
      }),
    );

    const probe = verifyBaseBranchHealth(projectId, db);
    await verifyHasStarted;

    // Another BACKGROUND chain queues behind the probe. Nothing gate-class is waiting, so the
    // probe must run on: a background measurement has nobody blocked behind it either.
    const other = runUnderVerifyChainSemaphore(async () => "b", "another probe", undefined, undefined, {
      priority: "background",
    });
    await new Promise((r) => setTimeout(r, PROBE_GATE_POLL_INTERVAL_MS_TEST));
    finishVerify();

    const result = await probe;
    await other;

    expect(result?.outcome).toBe("green");
    expect(probeConsecutiveYields(projectId)).toBe(0);
  }, 30000);
});
