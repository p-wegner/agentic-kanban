/**
 * #1178 — tests for the probe half of #1165: an EXPLICIT base-health probe competes for the
 * verify slot as a gate and never yields it.
 *
 * #1165's first half let an explicit reprobe (`pnpm promote`, the operator route) past the
 * `gate_running` pre-check. The probe it launched then still queued as `background` and still
 * yielded its running verify to every gate-class waiter (#989), so on a board merging
 * continuously it reached the slot only to give it up again — measured 2026-09-16: the promotion
 * requested a sweep, the probe yielded twice to review-exit gates, and the run gave up after 40
 * minutes with no verdict. The fix threads `BaseBranchProbeOptions.explicit` through
 * `verifyBaseBranchHealth` → `runBaseBranchProbe`, which sets the slot priority for BOTH
 * semaphore acquisitions (the main verify and the #1110 flake retry) and disables the #989 yield.
 *
 * Same harness as `base-branch-health-concurrency.test.ts`: the clone and the verify child are
 * mocked, the DB is real, and the verify-chain semaphore is the REAL one — wrapped only to record
 * the options each acquisition was made with, since that is the thing under test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projects } from "@agentic-kanban/shared/schema";
import { createTestDb } from "./helpers/test-db.js";

const runSetupScript = vi.fn();
vi.mock("@agentic-kanban/shared/lib/setup-script", () => ({
  runSetupScript: (...args: unknown[]) => runSetupScript(...args),
}));

vi.mock("@agentic-kanban/shared/lib/git-service", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    cloneBranchTo: async (_repo: string, _branch: string, dest: string) => { mkdirSync(dest, { recursive: true }); },
    revParse: async () => "abc1234",
  };
});

/**
 * The flake retry (#1110) only runs for a project whose verify honours suite scoping, which the
 * probe decides with `isSelfProjectRepo`. A temp repo is never the self root, so the retry path
 * would be unreachable here without this — and the retry's slot acquisition is half of what
 * #1165 changed.
 */
const isSelfProjectRepo = vi.fn(() => false);
vi.mock("../services/self-project.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, isSelfProjectRepo: () => isSelfProjectRepo() };
});

/** Every `runUnderVerifyChainSemaphore` acquisition the probe made: its label and its options. */
const semaphoreCalls: Array<{ label: string | undefined; opts: { priority?: string } | undefined }> = [];
vi.mock("../services/verify-chain-semaphore.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/verify-chain-semaphore.js")>();
  return {
    ...actual,
    runUnderVerifyChainSemaphore: ((...args: Parameters<typeof actual.runUnderVerifyChainSemaphore>) => {
      semaphoreCalls.push({ label: args[1], opts: args[4] });
      return actual.runUnderVerifyChainSemaphore(...args);
    }) as typeof actual.runUnderVerifyChainSemaphore,
  };
});

const { verifyBaseBranchHealth } = await import("../services/base-branch-health.service.js");
const { setPreference } = await import("../repositories/preferences.repository.js");
const { verifyScriptPrefKey } = await import("../services/stack-profile.service.js");
const { getLatestBaseBranchHealth } = await import("../repositories/base-branch-health.repository.js");
const { runUnderVerifyChainSemaphore, verifyChainGateWaiting, resetVerifyChainSemaphoreForTests } =
  await import("../services/verify-chain-semaphore.js");
const { probeConsecutiveYields, resetProbeYieldStreaksForTests } =
  await import("../services/base-health-probe-preemption.js");

/** One attributable failing suite — exactly the shape `decideFlakeRetry` retries once. */
const FLAKY_OUTPUT = `
[test:mine] server: node vitest run
 FAIL  src/__tests__/monitor-file-contention.test.ts > one
 Test Files  1 failed | 761 passed (762)
`;

const OK = { exitCode: 0, stdout: "ok", stderr: "", timedOut: false };

/** Poll cadence for the yield check; production is 15s, which would make the no-yield case a 15s wait. */
const POLL_MS = 20;

const tempRepos: string[] = [];
function makeRepoPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "ak-base-health-explicit-repo-"));
  mkdirSync(join(dir, ".git"), { recursive: true });
  tempRepos.push(dir);
  return dir;
}

async function seedProject(db: ReturnType<typeof createTestDb>["db"]) {
  const now = new Date().toISOString();
  const projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId,
    name: "Explicit Probe Project",
    repoPath: makeRepoPath(),
    repoName: "repo",
    defaultBranch: "master",
    createdAt: now,
    updatedAt: now,
  });
  // No stack profile ⇒ no install command, so the probe goes straight to verify.
  await setPreference(verifyScriptPrefKey(projectId), "pnpm test", db);
  await setPreference(`risk_posture_${projectId}`, "standard", db);
  return projectId;
}

/** The main-verify and flake-retry acquisitions, told apart by the label the probe passes. */
const mainVerifyCalls = () => semaphoreCalls.filter((c) => c.label?.includes("health probe"));
const retryCalls = () => semaphoreCalls.filter((c) => c.label?.includes("flake retry"));

/**
 * A verify child that runs until the test releases it (or the probe aborts it). `aborted` reports
 * whether the probe's #989 kill fired, which is the one thing an explicit probe must never do.
 */
function mockHeldVerify() {
  let release: () => void = () => {};
  let aborted = false;
  let running = false;
  runSetupScript.mockImplementationOnce((_cwd: string, _script: string, opts?: { signal?: AbortSignal }) =>
    new Promise((resolve) => {
      running = true;
      opts?.signal?.addEventListener("abort", () => { aborted = true; resolve({ exitCode: 130, stdout: "", stderr: "", aborted: true }); }, { once: true });
      release = () => resolve(OK);
    }));
  return { release: () => release(), aborted: () => aborted, running: () => running };
}

let db: ReturnType<typeof createTestDb>["db"];

beforeEach(() => {
  vi.clearAllMocks();
  semaphoreCalls.length = 0;
  isSelfProjectRepo.mockReturnValue(false);
  ({ db } = createTestDb());
  runSetupScript.mockResolvedValue(OK);
  process.env.KANBAN_BASE_HEALTH_GATE_POLL_MS = String(POLL_MS);
  // Yields here happen in ms; with the 60s floor every one would be free and the streak vacuous.
  process.env.KANBAN_BASE_HEALTH_YIELD_STREAK_FLOOR_MS = "0";
  resetProbeYieldStreaksForTests();
  resetVerifyChainSemaphoreForTests();
});

afterEach(() => {
  delete process.env.KANBAN_BASE_HEALTH_GATE_POLL_MS;
  delete process.env.KANBAN_BASE_HEALTH_YIELD_STREAK_FLOOR_MS;
  resetProbeYieldStreaksForTests();
  // A held slot would leak into the next test and queue every later probe forever.
  resetVerifyChainSemaphoreForTests();
  while (tempRepos.length) {
    try { rmSync(tempRepos.pop()!, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe("the probe's verify-slot priority follows `explicit` (#1178, #1165)", () => {
  it("an explicit probe acquires the slot at { priority: \"gate\" }", async () => {
    const projectId = await seedProject(db);

    const result = await verifyBaseBranchHealth(projectId, db, undefined, { explicit: true });

    expect(result?.outcome).toBe("green");
    expect(mainVerifyCalls()).toHaveLength(1);
    expect(mainVerifyCalls()[0]!.opts).toEqual({ priority: "gate" });
  });

  it("the unattended sweep (no options) stays at { priority: \"background\" } — the box's one background user", async () => {
    const projectId = await seedProject(db);

    const result = await verifyBaseBranchHealth(projectId, db);

    expect(result?.outcome).toBe("green");
    expect(mainVerifyCalls()).toHaveLength(1);
    expect(mainVerifyCalls()[0]!.opts).toEqual({ priority: "background" });
  });

  it("{ explicit: false } is spelled out as background too, so the reprobe's plain call changes nothing", async () => {
    const projectId = await seedProject(db);

    await verifyBaseBranchHealth(projectId, db, undefined, { explicit: false });

    expect(mainVerifyCalls()[0]!.opts).toEqual({ priority: "background" });
  });

  it("the #1110 flake retry acquires the slot at the SAME priority as the main verify — both halves move together", async () => {
    // A retry that queued as background behind a gate-priority main run would hand the promotion
    // a red-then-wait on exactly the flaky suite it was retrying to clear.
    isSelfProjectRepo.mockReturnValue(true);
    runSetupScript
      .mockResolvedValueOnce({ exitCode: 1, stdout: FLAKY_OUTPUT, stderr: "", timedOut: false })
      .mockResolvedValueOnce(OK);
    const projectId = await seedProject(db);

    const explicitResult = await verifyBaseBranchHealth(projectId, db, undefined, { explicit: true });

    expect(explicitResult?.outcome).toBe("green");
    expect(explicitResult?.flaky).toBe(true);
    expect(mainVerifyCalls()).toHaveLength(1);
    expect(retryCalls()).toHaveLength(1);
    expect(mainVerifyCalls()[0]!.opts).toEqual({ priority: "gate" });
    expect(retryCalls()[0]!.opts).toEqual({ priority: "gate" });

    // And the unattended shape of the same run keeps both at background.
    semaphoreCalls.length = 0;
    runSetupScript
      .mockResolvedValueOnce({ exitCode: 1, stdout: FLAKY_OUTPUT, stderr: "", timedOut: false })
      .mockResolvedValueOnce(OK);
    const backgroundResult = await verifyBaseBranchHealth(projectId, db);

    expect(backgroundResult?.outcome).toBe("green");
    expect(retryCalls()).toHaveLength(1);
    expect(mainVerifyCalls()[0]!.opts).toEqual({ priority: "background" });
    expect(retryCalls()[0]!.opts).toEqual({ priority: "background" });
  });
});

describe("an explicit probe does not yield its running verify to a waiting gate (#1178, #1165)", () => {
  it("keeps the slot through several poll ticks with a gate queued, records its verdict, and only then lets the gate run", async () => {
    const projectId = await seedProject(db);
    const verify = mockHeldVerify();

    const probe = verifyBaseBranchHealth(projectId, db, undefined, { explicit: true });
    await vi.waitFor(() => expect(verify.running()).toBe(true));

    // A real gate-class waiter queues behind the probe — the situation that killed the 2026-09-16 sweep.
    let gateRan = false;
    const gate = runUnderVerifyChainSemaphore(async () => { gateRan = true; }, "a merge gate");
    await vi.waitFor(() => expect(verifyChainGateWaiting()).toBe(true));

    // Several poll ticks: a background probe would have aborted on the first of them (#989).
    await new Promise((r) => setTimeout(r, POLL_MS * 6));
    expect(verify.aborted()).toBe(false);
    expect(gateRan).toBe(false);
    // Not yielding is the CONFIGURATION of an explicit probe (`disabled`), so no streak is spent.
    expect(probeConsecutiveYields(projectId)).toBe(0);

    verify.release();
    const result = await probe;
    expect(result?.outcome).toBe("green");
    // The measurement that #1165 exists to deliver is actually on record...
    const row = await getLatestBaseBranchHealth(projectId, db);
    expect(row?.outcome).toBe("green");
    // ...and the gate was delayed, never starved: it runs once the slot is released.
    await gate;
    expect(gateRan).toBe(true);
  });

  it("control: the same run WITHOUT `explicit` yields to that gate — so the test above measures the flag, not the harness", async () => {
    const projectId = await seedProject(db);
    const verify = mockHeldVerify();

    const probe = verifyBaseBranchHealth(projectId, db);
    await vi.waitFor(() => expect(verify.running()).toBe(true));
    let gateRan = false;
    const gate = runUnderVerifyChainSemaphore(async () => { gateRan = true; }, "a merge gate");

    // Yielded: nothing recorded, the streak spent, the gate ran before the verify would have finished.
    expect(await probe).toBeNull();
    expect(verify.aborted()).toBe(true);
    expect(probeConsecutiveYields(projectId)).toBe(1);
    expect(await getLatestBaseBranchHealth(projectId, db)).toBeNull();
    await gate;
    expect(gateRan).toBe(true);
  });
});
