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
  buildPromotionPlan,
  formatPlan,
  nextStableTag,
  parseStableTag,
  parseSweepVerdict,
  previousStableTag,
  resolveBoardUrl,
  resolveMaxSweepAgeMs,
  resolveProjectName,
  resolveStableCheckout,
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

  it("logs under the stable checkout's .kanban directory", () => {
    expect(PROMOTE_LOG_RELPATH.replace(/\\/g, "/")).toBe(".kanban/promote.log");
  });
});
