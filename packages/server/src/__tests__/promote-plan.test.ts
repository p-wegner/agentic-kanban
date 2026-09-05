// @gate:always-run — imports scripts/promote-plan.mjs, which no package-local diff links to (#687).
/**
 * Unit tests for the PURE half of `pnpm promote` (#1014): tag naming, sweep-verdict parsing,
 * and the dry-run plan. Nothing here promotes, tags, starts a server or opens a database —
 * that is exactly why the deciding logic lives in `promote-plan.mjs` and not in the driver.
 */
import { describe, expect, it } from "vitest";
// Typed by the hand-written `scripts/promote-plan.d.mts`, per the `test-mine.d.mts` convention.
import {
  DEFAULT_MAX_SWEEP_AGE_HOURS,
  DEFAULT_STABLE_CHECKOUT_DIRNAME,
  PROMOTE_LOG_RELPATH,
  BOARD_LOG_RELPATH,
  DEFAULT_SWEEP_WAIT_MINUTES,
  buildPromotionPlan,
  checkPromoteDirection,
  formatPlan,
  isFreshSweepRow,
  isProbingThisProject,
  planSweepAcquisition,
  resolveSweepWaitMs,
  nextStableTag,
  parseStableTag,
  parseSweepVerdict,
  previousStableTag,
  resolveBoardUrl,
  resolveMaxSweepAgeMs,
  resolveProjectName,
  resolveStableCheckout,
  shouldForceSmokeFailure,
  shouldReinstall,
  sortStableTags,
  stableTagDate,
} from "../../../../scripts/promote-plan.mjs";

const HOUR = 3600_000;
const NOW = Date.parse("2026-09-04T12:00:00.000Z");
const greenRow = (over: Record<string, unknown> = {}) => ({
  sha: "abc1234def",
  branch: "master",
  outcome: "green",
  message: null,
  createdAt: new Date(NOW - 2 * HOUR).toISOString(),
  ...over,
});

describe("tag naming", () => {
  it("stamps the local day as YYYYMMDD", () => {
    expect(stableTagDate(new Date(2026, 8, 4, 13, 5))).toBe("20260904");
    expect(stableTagDate(new Date(2026, 0, 9, 0, 30))).toBe("20260109");
  });

  it("takes the bare day tag when it is free", () => {
    expect(nextStableTag("20260904", ["stable-20260903", "v1.2.3"])).toBe("stable-20260904");
  });

  it("suffixes -2, -3 … rather than moving an existing day tag", () => {
    expect(nextStableTag("20260904", ["stable-20260904"])).toBe("stable-20260904-2");
    expect(nextStableTag("20260904", ["stable-20260904", "stable-20260904-2"])).toBe("stable-20260904-3");
  });

  it("parses only well-formed stable tags", () => {
    expect(parseStableTag("stable-20260904")).toMatchObject({ date: "20260904", ordinal: 1 });
    expect(parseStableTag("stable-20260904-7")).toMatchObject({ date: "20260904", ordinal: 7 });
    expect(parseStableTag("stable")).toBeNull();
    expect(parseStableTag("v1.0.0")).toBeNull();
    expect(parseStableTag("stable-2026090")).toBeNull();
  });

  it("orders newest-first by date and then same-day ordinal", () => {
    expect(sortStableTags(["stable-20260901", "stable-20260904-2", "stable-20260904", "nope"])).toEqual([
      "stable-20260904-2",
      "stable-20260904",
      "stable-20260901",
    ]);
  });

  it("rolls back to the newest tag that is not the one just created", () => {
    const tags = ["stable-20260901", "stable-20260904", "stable-20260904-2"];
    expect(previousStableTag(tags, "stable-20260904-2")).toBe("stable-20260904");
    expect(previousStableTag(["stable-20260904"], "stable-20260904")).toBeNull();
    expect(previousStableTag([], "stable-20260904")).toBeNull();
  });
});

describe("sweep-verdict parsing", () => {
  it("accepts a fresh green sweep on the base branch", () => {
    const v = parseSweepVerdict(greenRow(), { branch: "master", nowMs: NOW, maxAgeMs: 36 * HOUR });
    expect(v.ok).toBe(true);
    expect(v.sha).toBe("abc1234def");
    expect(v.detail).toContain("abc1234def");
  });

  it("refuses a red sweep, naming sha, date and verdict", () => {
    const v = parseSweepVerdict(greenRow({ outcome: "red" }), { nowMs: NOW });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("red");
    expect(v.detail).toContain("abc1234def");
    expect(v.detail).toContain("red");
  });

  it("refuses timeout/unverified — a non-answer is not a green (isBaseHealthAnswer)", () => {
    for (const outcome of ["timeout", "unverified"]) {
      const v = parseSweepVerdict(greenRow({ outcome }), { nowMs: NOW });
      expect(v.ok).toBe(false);
      expect(v.reason).toBe("not-an-answer");
      expect(v.detail).toContain(outcome);
    }
  });

  it("refuses a green sweep older than the age budget", () => {
    const v = parseSweepVerdict(greenRow({ createdAt: new Date(NOW - 50 * HOUR).toISOString() }), {
      nowMs: NOW,
      maxAgeMs: 36 * HOUR,
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("stale");
    expect(v.detail).toContain("50.0h");
  });

  it("refuses a sweep recorded on another branch", () => {
    const v = parseSweepVerdict(greenRow({ branch: "release" }), { branch: "master", nowMs: NOW });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("wrong-branch");
  });

  it("refuses when no row exists at all, and when a green row carries no sha or no date", () => {
    expect(parseSweepVerdict(null, { nowMs: NOW })).toMatchObject({ ok: false, reason: "no-sweep" });
    expect(parseSweepVerdict(greenRow({ createdAt: null }), { nowMs: NOW })).toMatchObject({ ok: false, reason: "undated" });
    expect(parseSweepVerdict(greenRow({ sha: null }), { nowMs: NOW })).toMatchObject({ ok: false, reason: "no-sha" });
  });

  it("reads the snake_case column name a direct sqlite read returns", () => {
    const { createdAt: _drop, ...row } = greenRow();
    const v = parseSweepVerdict({ ...row, created_at: new Date(NOW - HOUR).toISOString() }, { nowMs: NOW });
    expect(v.ok).toBe(true);
  });
});

describe("environment resolution", () => {
  it("defaults the stable checkout to a sibling and honours the override", () => {
    expect(resolveStableCheckout({ env: {}, repoRoot: "/repos/agentic-kanban" })).toContain(DEFAULT_STABLE_CHECKOUT_DIRNAME);
    expect(resolveStableCheckout({ env: { KANBAN_STABLE_CHECKOUT: "/elsewhere/stable" }, repoRoot: "/repos/x" }))
      .toContain("stable");
  });

  it("defaults the board URL to the stable board's port and strips a trailing slash", () => {
    expect(resolveBoardUrl({})).toBe("http://127.0.0.1:3001");
    expect(resolveBoardUrl({ KANBAN_PROMOTE_BOARD_URL: "http://127.0.0.1:3001/" })).toBe("http://127.0.0.1:3001");
  });

  it("falls back to the default sweep age for absent and nonsense values", () => {
    expect(resolveMaxSweepAgeMs({})).toBe(DEFAULT_MAX_SWEEP_AGE_HOURS * HOUR);
    expect(resolveMaxSweepAgeMs({ KANBAN_PROMOTE_MAX_SWEEP_AGE_H: "not-a-number" })).toBe(DEFAULT_MAX_SWEEP_AGE_HOURS * HOUR);
    expect(resolveMaxSweepAgeMs({ KANBAN_PROMOTE_MAX_SWEEP_AGE_H: "-3" })).toBe(DEFAULT_MAX_SWEEP_AGE_HOURS * HOUR);
    expect(resolveMaxSweepAgeMs({ KANBAN_PROMOTE_MAX_SWEEP_AGE_H: "6" })).toBe(6 * HOUR);
  });

  it("defaults the project to agentic-kanban", () => {
    expect(resolveProjectName({})).toBe("agentic-kanban");
    expect(resolveProjectName({ KANBAN_PROMOTE_PROJECT: "other" })).toBe("other");
  });
});

describe("install gating", () => {
  it("re-installs only when the lockfile blob moved", () => {
    expect(shouldReinstall("aaa", "aaa")).toBe(false);
    expect(shouldReinstall("aaa", "bbb")).toBe(true);
    expect(shouldReinstall("", "bbb")).toBe(true);
  });
});

describe("the dry-run plan", () => {
  const input = {
    sha: "abc1234def",
    tag: "stable-20260904",
    previousTag: "stable-20260903" as string | null,
    stableCheckout: "C:/repos/agentic-kanban-stable",
    repoRoot: "C:/repos/agentic-kanban",
    boardUrl: "http://127.0.0.1:3001",
    dbPath: "C:/Users/x/.agentic-kanban/kanban.db",
    sweepSource: "board HTTP http://127.0.0.1:3001",
    sweepVerdict: "green sweep — sha abc1234def",
    projectName: "agentic-kanban",
    stablePort: 3001,
    dbUrl: "file:C:/Users/x/.agentic-kanban/kanban.db",
    logPath: "C:/repos/agentic-kanban-stable/.kanban/promote.log",
    boardLogPath: "C:/repos/agentic-kanban-stable/.kanban/board.log",
  };
  const plan = () => buildPromotionPlan(input);

  it("is the ticket's four phases in order, plus rollback and the log", () => {
    const steps = plan();
    expect(steps.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const text = formatPlan(steps);
    expect(text).toContain("abc1234def");
    expect(text).toContain("stable-20260904");
    expect(text).toContain("agentic-kanban-stable");
    expect(text).toContain("promote.log");
    expect(text).toContain("--ff-only");
    expect(text).toContain("/health");
    expect(text).toContain("/api/projects");
  });

  it("names the rollback target, and says so plainly when there is none", () => {
    expect(formatPlan(plan())).toContain("stable-20260903");
    const first = buildPromotionPlan({ ...input, previousTag: null });
    expect(formatPlan(first)).toContain("first promotion");
  });

  it("marks step 1 as skipped and warns when --force-sweep is set", () => {
    const forced = buildPromotionPlan({ ...input, forceSweep: true });
    expect(forced[0].title).toContain("SKIPPED");
    expect(forced[0].detail).toContain("WARNING");
  });

  it("says step 1 will TRIGGER a sweep when the run intends to acquire one (#1044)", () => {
    const acquiring = buildPromotionPlan({
      ...input,
      sweepAcquisition: { request: true, reason: "acquire", detail: "no usable sweep verdict (stale) — requesting a fresh sweep" },
    });
    expect(acquiring[0].title).toContain("TRIGGER");
    expect(acquiring[0].detail).toContain("requesting a fresh sweep");
    // and it must not claim to trigger anything when it is only reading a recorded verdict
    expect(plan()[0].title).not.toContain("TRIGGER");
  });

  it("prints the accumulated-gate evidence next to the verdict, marked as authorizing nothing (#1045)", () => {
    const withEvidence = buildPromotionPlan({ ...input, gateEvidence: "7 green gate run(s) covering 43 changed file(s)" });
    expect(withEvidence[0].detail).toContain("7 green gate run(s)");
    expect(withEvidence[0].detail).toContain("does not authorize a promotion");
  });

  it("logs under the stable checkout's .kanban directory", () => {
    expect(PROMOTE_LOG_RELPATH.replace(/\\/g, "/")).toBe(".kanban/promote.log");
  });

  it("keeps the started board's output OFF the audit trail the Sentinel reads", () => {
    // Two writers on one file cost a real run's opening record on 2026-09-05: the 10:02
    // promotion's header/sweep/direction/tag lines were absent from promote.log while the
    // outgoing board's output for those minutes was there. The separation is the fix.
    expect(BOARD_LOG_RELPATH.replace(/\\/g, "/")).toBe(".kanban/board.log");
    expect(BOARD_LOG_RELPATH).not.toBe(PROMOTE_LOG_RELPATH);
    // and the dry run must NAME both, or an operator tailing one file will not know the other exists
    const text = formatPlan(plan());
    expect(text).toContain("promote.log");
    expect(text).toContain("board.log");
  });
});

/**
 * #1044 — the reproduction of the trap, and the fix.
 *
 * The trap was a CYCLE, not a single bad verdict: `--force-sweep` promotes the branch tip, which
 * leaves the stable checkout ahead of the last recorded sweep, so the next honest run reads a
 * green verdict for an ancestor of what is already deployed and is (correctly) refused as
 * `behind` — with `--force-sweep` as the only way out, which sets the trap again.
 */
describe("sweep acquisition (#1044)", () => {
  const green = parseSweepVerdict(greenRow(), { nowMs: NOW });
  const behind = { ok: false, reason: "behind" as const, detail: "the sha to promote is NOT a descendant" };
  const forward = { ok: true, reason: "forward" as const, detail: "ahead" };

  it("REPRODUCES the trap: a green verdict behind the stable checkout asks for a fresh sweep instead of refusing", () => {
    // Exactly the state a --force-sweep promotion leaves behind. Before the fix this combination
    // had no path forward at all: the verdict is fine, the direction check refuses, and nothing
    // in the run could produce the newer verdict that would satisfy both.
    const decision = planSweepAcquisition({ verdict: green, direction: behind });
    expect(decision.request).toBe(true);
    expect(decision.detail).toContain("BEHIND");
  });

  it("asks for a sweep for every refusal a fresh sweep would actually resolve", () => {
    for (const row of [
      null,
      greenRow({ createdAt: new Date(NOW - 200 * HOUR).toISOString() }),
      greenRow({ outcome: "timeout" }),
      greenRow({ sha: null }),
      greenRow({ branch: "main" }),
    ]) {
      const verdict = parseSweepVerdict(row, { nowMs: NOW });
      expect(verdict.ok).toBe(false);
      expect(planSweepAcquisition({ verdict, direction: null }).request).toBe(true);
    }
  });

  it("does NOT re-probe a red master, an unreadable board, or a verdict that already works", () => {
    const red = planSweepAcquisition({ verdict: parseSweepVerdict(greenRow({ outcome: "red" }), { nowMs: NOW }) });
    expect(red.request).toBe(false);
    expect(red.reason).toBe("red");

    const unreadable = planSweepAcquisition({
      verdict: { ok: false, reason: "unreadable", detail: "could not read" },
    });
    expect(unreadable.request).toBe(false);
    expect(unreadable.reason).toBe("unreadable");

    const usable = planSweepAcquisition({ verdict: green, direction: forward });
    expect(usable.request).toBe(false);
    expect(usable.reason).toBe("verdict-usable");
  });

  it("acquires nothing under --force-sweep, --no-await-sweep, or with no board to ask", () => {
    const stale = parseSweepVerdict(greenRow({ createdAt: new Date(NOW - 200 * HOUR).toISOString() }), { nowMs: NOW });
    expect(planSweepAcquisition({ verdict: stale, forceSweep: true }).reason).toBe("force-sweep");
    expect(planSweepAcquisition({ verdict: stale, awaitSweep: false }).reason).toBe("disabled");
    const noBoard = planSweepAcquisition({ verdict: stale, canRequest: false });
    expect(noBoard.request).toBe(false);
    expect(noBoard.reason).toBe("no-board");
  });

  it("counts a landed verdict as fresh only when it is a different observation", () => {
    const previous = greenRow();
    expect(isFreshSweepRow(previous, previous)).toBe(false);
    // a second green on the SAME sha still counts — the probe inserts, so the timestamp moved
    expect(isFreshSweepRow(greenRow({ createdAt: new Date(NOW).toISOString() }), previous)).toBe(true);
    expect(isFreshSweepRow(greenRow({ sha: "999" }), previous)).toBe(true);
    expect(isFreshSweepRow(null, previous)).toBe(false);
    expect(isFreshSweepRow(previous, null)).toBe(true);
    // sqlite spells it snake_case; the two spellings must not read as two different rows
    const snake = { sha: previous.sha, created_at: previous.createdAt };
    expect(isFreshSweepRow(snake, previous)).toBe(false);
  });

  it("reads 'a probe is running' only from signals about THIS project", () => {
    expect(isProbingThisProject({ started: true, skippedReason: null, joinedRunningProbe: false })).toBe(true);
    expect(isProbingThisProject({ started: false, skippedReason: "probe_in_flight", joinedRunningProbe: true })).toBe(true);
    // `joinedRunningProbe` is the board-WIDE in-flight count. Believing it here makes the run
    // stop asking and wait out its whole budget for a verdict another project's probe will never
    // record — a refusal that sends the operator back to --force-sweep, i.e. the #1044 trap.
    expect(isProbingThisProject({ started: false, skippedReason: "gate_running", joinedRunningProbe: true })).toBe(false);
    expect(isProbingThisProject({ started: false, skippedReason: "host_saturated", joinedRunningProbe: true })).toBe(false);
    expect(isProbingThisProject(null)).toBe(false);
  });

  it("waits a probe-sized time by default, and takes an override in minutes", () => {
    expect(resolveSweepWaitMs({})).toBe(DEFAULT_SWEEP_WAIT_MINUTES * 60_000);
    expect(resolveSweepWaitMs({ KANBAN_PROMOTE_SWEEP_WAIT_MIN: "5" })).toBe(5 * 60_000);
    expect(resolveSweepWaitMs({ KANBAN_PROMOTE_SWEEP_WAIT_MIN: "0" })).toBe(DEFAULT_SWEEP_WAIT_MINUTES * 60_000);
    expect(resolveSweepWaitMs({ KANBAN_PROMOTE_SWEEP_WAIT_MIN: "nonsense" })).toBe(DEFAULT_SWEEP_WAIT_MINUTES * 60_000);
  });
});

describe("shouldForceSmokeFailure", () => {
  it("is off unless explicitly armed", () => {
    expect(shouldForceSmokeFailure({})).toBe(false);
    expect(shouldForceSmokeFailure({ KANBAN_PROMOTE_FORCE_SMOKE_FAILURE: "" })).toBe(false);
    expect(shouldForceSmokeFailure({ KANBAN_PROMOTE_FORCE_SMOKE_FAILURE: "0" })).toBe(false);
  });

  it("accepts the spellings an operator actually types", () => {
    for (const v of ["1", "true", "TRUE", " yes "]) {
      expect(shouldForceSmokeFailure({ KANBAN_PROMOTE_FORCE_SMOKE_FAILURE: v })).toBe(true);
    }
  });
});

describe("checkPromoteDirection", () => {
  it("permits a forward move and a no-op onto the same sha", () => {
    expect(checkPromoteDirection({ stableHead: "aaa", sha: "bbb", shaIsDescendant: true }).ok).toBe(true);
    expect(checkPromoteDirection({ stableHead: "aaa", sha: "aaa", shaIsDescendant: false }).reason).toBe("same");
  });

  it("REFUSES a sha the stable checkout is already ahead of, because ff-only would silently no-op", () => {
    const d = checkPromoteDirection({ stableHead: "newer", sha: "older", shaIsDescendant: false });
    expect(d.ok).toBe(false);
    expect(d.reason).toBe("behind");
    expect(d.detail).toContain("silent no-op");
  });

  it("does not block when a sha could not be read at all", () => {
    expect(checkPromoteDirection({ stableHead: "", sha: "abc", shaIsDescendant: false }).ok).toBe(true);
  });
});
