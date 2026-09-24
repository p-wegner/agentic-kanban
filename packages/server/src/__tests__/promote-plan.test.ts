// @gate:always-run when:scripts/promote-plan.mjs — imports scripts/promote-plan.mjs, which no package-local diff links to (#687).
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
  formatFlowSweepStatement,
  formatPlan,
  isFreshSweepRow,
  isProbingThisProject,
  planSweepAcquisition,
  REPROBEABLE_SWEEP_REASONS,
  planRestartOnly,
  formatRestartRefusal,
  formatPromoteUsage,
  formatUnknownFlagRefusal,
  parsePromoteArgv,
  KNOWN_PROMOTE_FLAGS,
  planRecoveryLane,
  classifyRecoveryDelta,
  buildRecoveryRecord,
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

describe("strict argv parsing (#1222)", () => {
  it("refuses an unknown flag instead of falling through to a live promotion", () => {
    const r = parsePromoteArgv(["--help"]);
    // --help IS known (this is the regression case): it must parse ok and be flagged as help,
    // never as an unknown flag that falls through.
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.help).toBe(true);
  });

  it("refuses a genuine typo of a known flag", () => {
    const r = parsePromoteArgv(["--dryrun"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.unknown).toEqual(["--dryrun"]);
      expect(r.knownFlags).toEqual([...KNOWN_PROMOTE_FLAGS]);
    }
  });

  it("refuses every unrecognised token, not just the first", () => {
    const r = parsePromoteArgv(["--dry_run", "--forcesweep"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.unknown).toEqual(["--dry_run", "--forcesweep"]);
  });

  it("accepts -h as well as --help", () => {
    const r = parsePromoteArgv(["-h"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.help).toBe(true);
  });

  it("parses every real flag combination without flagging it unknown", () => {
    const r = parsePromoteArgv(["--recover", "--with-migration", "--reason", "fix the leak"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.recover).toBe(true);
      expect(r.withMigration).toBe(true);
      expect(r.reason).toBe("fix the leak");
      expect(r.help).toBe(false);
      expect(r.dryRun).toBe(false);
    }
  });

  it("does not treat --reason's value as a flag even when it looks like one", () => {
    // A reason starting with "-" is rejected as a value (matches the old inline parser's
    // behaviour) rather than being swallowed as an unknown flag.
    const r = parsePromoteArgv(["--reason", "--not-a-real-reason"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.reason).toBeNull();
  });

  it("treats a bare --reason with nothing after it as reason: null, not a dangling flag", () => {
    const r = parsePromoteArgv(["--reason"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.reason).toBeNull();
  });

  it("formats a usage block and an unknown-flag refusal that lists the known flags", () => {
    expect(formatPromoteUsage()).toContain("--dry-run");
    expect(formatPromoteUsage()).toContain("--help");
    const refusal = formatUnknownFlagRefusal(["--dryrun"]);
    expect(refusal).toContain("--dryrun");
    for (const flag of KNOWN_PROMOTE_FLAGS) expect(refusal).toContain(flag);
  });

  it("defaults to every flag false and reason null on empty argv", () => {
    const r = parsePromoteArgv([]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r).toMatchObject({
        help: false,
        dryRun: false,
        forceSweep: false,
        noAwaitSweep: false,
        recover: false,
        withMigration: false,
        restartStable: false,
        reason: null,
      });
    }
  });
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

  describe("the sweep's self-reported scope (#1231)", () => {
    it("refuses a green whose scope is present and not `full` — a scoped green is not the full-suite signal", () => {
      for (const scope of ["file-scoped", "package-scoped", "impact-selected", "impact+related", "guards-only", "flake-retry"]) {
        const v = parseSweepVerdict(greenRow({ scope }), { nowMs: NOW });
        expect(v.ok, scope).toBe(false);
        expect(v.reason).toBe("scoped");
        expect(v.scope).toBe(scope);
        expect(v.detail).toContain(`scope=${scope}`);
        expect(v.detail).toContain("not the full suite");
      }
    });

    it("accepts a green whose scope is `full`, and carries the scope on the verdict", () => {
      const v = parseSweepVerdict(greenRow({ scope: "full" }), { nowMs: NOW });
      expect(v.ok).toBe(true);
      expect(v.scope).toBe("full");
      expect(v.detail).toContain("scope full");
    });

    it("accepts a NULL / absent scope (a pre-#1231 row, or a verify script with no step contract) and SAYS so", () => {
      for (const row of [greenRow(), greenRow({ scope: null }), greenRow({ scope: undefined })]) {
        const v = parseSweepVerdict(row, { nowMs: NOW });
        expect(v.ok).toBe(true);
        expect(v.scope).toBeNull();
        expect(v.detail).toContain("scope <none: unknown, accepted>");
      }
    });

    it("a RED row is still refused as red, whatever its scope — scope only qualifies a green", () => {
      const v = parseSweepVerdict(greenRow({ outcome: "red", scope: "file-scoped" }), { nowMs: NOW });
      expect(v.reason).toBe("red");
      expect(v.scope).toBe("file-scoped");
    });

    it("a scoped green is REPROBEABLE — since #1231 a fresh sweep runs full, so a re-probe resolves it", () => {
      expect(REPROBEABLE_SWEEP_REASONS).toContain("scoped");
      const scoped = parseSweepVerdict(greenRow({ scope: "file-scoped" }), { nowMs: NOW });
      const plan = planSweepAcquisition({ verdict: scoped, canRequest: true });
      expect(plan.request).toBe(true);
      expect(plan.detail).toContain("scoped");
    });
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
describe("the dry-run plan under `flow` (#1240)", () => {
  it("names the rc verdict instead of master's, and changes nothing for any other posture", () => {
    expect(formatFlowSweepStatement({ postureLevel: "iterate", dateStamp: "20260924" })).toBeNull();
    expect(formatFlowSweepStatement({ postureLevel: undefined, dateStamp: "20260924" })).toBeNull();
    const line = formatFlowSweepStatement({ postureLevel: "flow", dateStamp: "20260924" });
    expect(line).toMatch(/master has NO scheduled sweep by design/);
    expect(line).toContain("release candidate only");
    expect(line).toContain("rc/20260924[-N]");

    const base = {
      sha: "abc1234def", tag: "stable-20260924-2", previousTag: null, stableCheckout: "C:/s", repoRoot: "C:/r",
      boardUrl: "http://127.0.0.1:3001", dbPath: "C:/db", sweepSource: "board HTTP", sweepVerdict: "green sweep — sha abc1234def",
      projectName: "agentic-kanban", stablePort: 3001, dbUrl: "file:C:/db", logPath: "C:/s/.kanban/promote.log",
    };
    const flow = buildPromotionPlan({ ...base, postureLevel: "flow" });
    // The date is the TAG's day, so the statement names the cut this promotion belongs to.
    expect(flow[0].detail).toMatch(/^risk posture 'flow'.*rc\/20260924\[-N\]/);
    expect(flow[0].detail).toContain("green sweep — sha abc1234def");
    expect(formatPlan(flow)).toContain("release candidate only");
    // Every other posture (and an absent one) renders byte-for-byte what it did before #1240.
    expect(buildPromotionPlan({ ...base, postureLevel: "iterate" })).toEqual(buildPromotionPlan(base));
  });
});

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
    // The red row's sha IS the tip here (greenRow's default sha, passed as headSha), which is the
    // case #1044 refuses and #1060 leaves untouched.
    const redRow = greenRow({ outcome: "red" });
    const red = planSweepAcquisition({
      verdict: parseSweepVerdict(redRow, { nowMs: NOW }),
      headSha: redRow.sha,
    });
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

  /**
   * #1060 — the other half of #1044's trap, found by walking into it twice on 2026-09-08.
   *
   * #1044 taught promote to REQUEST the sweep it needs, but only for a verdict that was green
   * (and stale or behind). A RED verdict refused outright, on the rule "re-probing a broken
   * master is not evidence-gathering" — correct while the verdict still describes the tree, and
   * wrong the moment the breach is FIXED. The red row is then about a commit that is no longer
   * the tip and says nothing about the new one.
   *
   * The lived sequence: promotion went red on a #726 branch-ceiling breach; the breach was fixed
   * on master minutes later; the next run refused with "Fix master" — which had just been done —
   * and offered only `--force-sweep`. That is the single path #1044 exists to stop being routine,
   * so the red branch was re-creating the trap #1044 closed for green.
   */
  describe("a RED verdict that no longer describes the tree (#1060)", () => {
    const redRow = greenRow({ outcome: "red", sha: "36dc67366d" });
    const redVerdict = parseSweepVerdict(redRow, { nowMs: NOW });

    it("REPRODUCES the trap: fixing master past a red verdict now asks for a fresh sweep", () => {
      const decision = planSweepAcquisition({ verdict: redVerdict, headSha: "bb0c5a903d" });
      expect(decision.request).toBe(true);
      expect(decision.reason).toBe("acquire");
      // The message has to say WHY this is not a re-probe of a broken master, or the next reader
      // reasonably concludes the #1044 rule was simply dropped.
      expect(decision.detail).toContain("36dc67366d");
      expect(decision.detail).toContain("bb0c5a903d");
      expect(decision.detail).toContain("no longer the tip");
    });

    it("still refuses while the red verdict IS the tip — #1044's rule is intact", () => {
      const decision = planSweepAcquisition({ verdict: redVerdict, headSha: redRow.sha });
      expect(decision.request).toBe(false);
      expect(decision.reason).toBe("red");
      // And it now tells the operator what to do next, which the old wording did not: it said
      // "Fix master" to someone who had just fixed master.
      expect(decision.detail).toContain("re-run this");
    });

    it("refuses when HEAD is unknown — a comparison that cannot be made is not a licence", () => {
      // Fail-safe direction: without a tip to compare against, keep #1044's behaviour exactly.
      expect(planSweepAcquisition({ verdict: redVerdict, headSha: null }).reason).toBe("red");
      expect(planSweepAcquisition({ verdict: redVerdict }).reason).toBe("red");
    });

    it("refuses when the red verdict carries no sha at all", () => {
      const noSha = parseSweepVerdict(greenRow({ outcome: "red", sha: null }), { nowMs: NOW });
      // `parseSweepVerdict` may classify a sha-less row by another reason; whichever it picks,
      // the one thing that must not happen is a request justified by a comparison against null.
      const decision = planSweepAcquisition({ verdict: noSha, headSha: "bb0c5a903d" });
      if (decision.request) expect(decision.detail).not.toContain("no longer the tip");
    });

    it("--force-sweep and --no-await-sweep still win over the new path", () => {
      expect(planSweepAcquisition({ verdict: redVerdict, headSha: "bb0c5a903d", forceSweep: true }).reason)
        .toBe("force-sweep");
      expect(planSweepAcquisition({ verdict: redVerdict, headSha: "bb0c5a903d", awaitSweep: false }).reason)
        .toBe("disabled");
      expect(planSweepAcquisition({ verdict: redVerdict, headSha: "bb0c5a903d", canRequest: false }).reason)
        .toBe("no-board");
    });
  });

  /**
   * #1061 — the third member of this family, and the only one that does not refuse.
   *
   * `sha` to promote is `verdict.sha` whenever the verdict is green, so when the verdict
   * describes exactly what stable already runs, a promotion mints a SECOND tag on that identical
   * sha, rebuilds, restarts the operating board, prints "is live", and leaves every commit made
   * since unpromoted. `checkPromoteDirection` calls that `{ ok: true, reason: "same" }` — "not
   * blocking" — which is what let it through. But `same` means the recorded verdict cannot
   * authorize ANY change, not that everything is fine.
   *
   * Measured on a real dry run: stable at 599a1ba507, master 4 commits ahead, verdict green for
   * 599a1ba507 -> "the recorded sweep verdict already authorizes this promotion", planning
   * `tag stable-20260908-2 on 599a1ba507`.
   */
  describe("a green verdict for exactly what stable already runs (#1061)", () => {
    const same = { ok: true, reason: "same" as const, detail: "stable checkout is already at abc1234def" };

    it("REPRODUCES the no-op: a branch that has moved on asks for a fresh sweep", () => {
      const decision = planSweepAcquisition({ verdict: green, direction: same, headSha: "e42fa67842" });
      expect(decision.request).toBe(true);
      expect(decision.reason).toBe("acquire");
      expect(decision.detail).toContain("already runs");
      expect(decision.detail).toContain("e42fa67842");
      // The consequence has to be named, or this reads as a pointless re-sweep of a green tree.
      expect(decision.detail).toContain("leave the newer commits behind");
    });

    it("asks for nothing when the branch is AT that sha too — there is simply nothing to promote", () => {
      // Not an acquisition problem: a fresh sweep would say the same thing. `promote.mjs` handles
      // this one at the direction check, exiting 0 without tagging or restarting.
      const decision = planSweepAcquisition({ verdict: green, direction: same, headSha: green.sha });
      expect(decision.request).toBe(false);
      expect(decision.reason).toBe("verdict-usable");
    });

    it("asks for nothing when the branch tip is unknown", () => {
      // Fail-safe, as with the red case: without a tip there is no comparison to justify a wait.
      expect(planSweepAcquisition({ verdict: green, direction: same, headSha: null }).request).toBe(false);
    });

    it("leaves the forward case alone — the ordinary promotion must not start sweeping", () => {
      const decision = planSweepAcquisition({ verdict: green, direction: forward, headSha: "e42fa67842" });
      expect(decision.request).toBe(false);
      expect(decision.reason).toBe("verdict-usable");
    });
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

// --- the restart-only door (#1202) ------------------------------------------------------------

describe("formatRestartRefusal", () => {
  it("names the pid, the port, and the command line", () => {
    expect(formatRestartRefusal({ pid: "4242", port: 3001, commandLine: "node dist/cli/index.js dev" })).toBe(
      "refused: 4242 already serves 3001 (node dist/cli/index.js dev)",
    );
  });

  it("says so when the command line could not be read, rather than printing an empty parenthesis", () => {
    expect(formatRestartRefusal({ pid: "4242", port: 3001, commandLine: "" })).toBe(
      "refused: 4242 already serves 3001 (<command line unavailable>)",
    );
  });

  it("truncates a very long command line instead of blowing up a log line", () => {
    const long = "node " + "x".repeat(300);
    const line = formatRestartRefusal({ pid: "1", port: 3001, commandLine: long });
    expect(line).toContain("...");
    expect(line.length).toBeLessThan(long.length);
  });
});

describe("planRestartOnly (#1202)", () => {
  it("REFUSES without spawning when a pid already holds the port — whether or not it is the stable board's own", () => {
    const heldByStable = planRestartOnly({
      port: 3001,
      owners: [{ pid: "100", commandLine: "node C:/stable/packages/server/dist/cli/index.js dev" }],
    });
    expect(heldByStable.ok).toBe(false);
    expect(heldByStable.code).toBe(2);
    expect(heldByStable.lines).toEqual(["refused: 100 already serves 3001 (node C:/stable/packages/server/dist/cli/index.js dev)"]);

    const heldByOther = planRestartOnly({ port: 3001, owners: [{ pid: "200", commandLine: "some-other-process" }] });
    expect(heldByOther.ok).toBe(false);
    expect(heldByOther.code).toBe(2);
    expect(heldByOther.lines[0]).toContain("refused: 200 already serves 3001");
  });

  it("reports every owning pid, not just the first, when several answer the port", () => {
    const d = planRestartOnly({
      port: 3001,
      owners: [
        { pid: "100", commandLine: "a" },
        { pid: "101", commandLine: "b" },
      ],
    });
    expect(d.lines).toHaveLength(2);
    expect(d.detail).toContain("100");
    expect(d.detail).toContain("101");
  });

  it("permits a start (the caller's cue to spawn) when nothing listens on the port", () => {
    const d = planRestartOnly({ port: 3001, owners: [] });
    expect(d.ok).toBe(true);
    expect(d.code).toBe(0);
    expect(d.lines).toEqual([]);
  });

  it("defaults owners to empty, so a bare call also permits a start", () => {
    expect(planRestartOnly({ port: 3001 }).ok).toBe(true);
  });
});

// --- the recovery lane (#1054) ---------------------------------------------------------------

describe("recovery lane: delta classification", () => {
  it("counts commits and files and reports no migration for an ordinary delta", () => {
    const d = classifyRecoveryDelta({
      commits: ["aaa fix the leak", "bbb test"],
      changedFiles: ["packages/server/src/a.ts", "packages/client/src/b.tsx"],
    });
    expect(d.commitCount).toBe(2);
    expect(d.fileCount).toBe(2);
    expect(d.hasMigration).toBe(false);
    expect(d.migrations).toEqual([]);
  });

  it("spots a migration anywhere in the delta", () => {
    const d = classifyRecoveryDelta({
      commits: ["aaa schema"],
      changedFiles: ["packages/server/src/a.ts", "packages/shared/drizzle/0153_new_table.sql"],
    });
    expect(d.hasMigration).toBe(true);
    expect(d.migrations).toEqual(["packages/shared/drizzle/0153_new_table.sql"]);
  });

  it("spots a migration given with WINDOWS separators — git can hand back either", () => {
    const d = classifyRecoveryDelta({
      commits: ["aaa schema"],
      changedFiles: ["packages\\shared\\drizzle\\0153_new_table.sql"],
    });
    expect(d.hasMigration).toBe(true);
  });

  it("does not treat a path that merely mentions drizzle as a migration", () => {
    const d = classifyRecoveryDelta({
      commits: ["aaa"],
      changedFiles: ["packages/server/src/db/drizzle-helpers.ts", "docs/drizzle.md"],
    });
    expect(d.hasMigration).toBe(false);
  });

  it("is empty, not broken, for a delta with nothing in it", () => {
    const d = classifyRecoveryDelta();
    expect(d).toMatchObject({ commitCount: 0, fileCount: 0, hasMigration: false });
  });
});

describe("recovery lane: what it refuses", () => {
  const reversible = classifyRecoveryDelta({
    commits: ["aaa fix"],
    changedFiles: ["packages/server/src/a.ts"],
  });
  const withMigration = classifyRecoveryDelta({
    commits: ["aaa schema"],
    changedFiles: ["packages/shared/drizzle/0153_x.sql"],
  });

  it("permits a delta whose every change a rollback can undo", () => {
    const lane = planRecoveryLane({ delta: reversible });
    expect(lane.ok).toBe(true);
    expect(lane.reason).toBe("reversible");
  });

  it("does NOT cap the delta by size — the operator is the review on a single-user board", () => {
    const big = classifyRecoveryDelta({
      commits: Array.from({ length: 40 }, (_, i) => `c${i} commit`),
      changedFiles: Array.from({ length: 300 }, (_, i) => `packages/server/src/f${i}.ts`),
    });
    expect(planRecoveryLane({ delta: big }).ok).toBe(true);
  });

  it("refuses a migration — the one change the rollback cannot reverse", () => {
    const lane = planRecoveryLane({ delta: withMigration });
    expect(lane.ok).toBe(false);
    expect(lane.reason).toBe("migration");
    // The refusal has to say WHY, or the operator just reaches for --force-sweep.
    expect(lane.detail).toContain("forward-only");
    expect(lane.detail).toContain("--with-migration");
  });

  it("proceeds on a migration once it is explicitly acked", () => {
    const lane = planRecoveryLane({ delta: withMigration, withMigration: true });
    expect(lane.ok).toBe(true);
    expect(lane.reason).toBe("migration-acked");
  });

  it("refuses when the delta could not be computed at all, rather than assuming it is empty", () => {
    const lane = planRecoveryLane({ delta: null });
    expect(lane.ok).toBe(false);
    expect(lane.reason).toBe("no-delta");
  });
});

describe("recovery lane: the disclosure it leaves behind", () => {
  it("records that a sweep is OWED, with the delta and the rollback target", () => {
    const delta = classifyRecoveryDelta({ commits: ["aaa"], changedFiles: ["packages/server/src/a.ts"] });
    const rec = buildRecoveryRecord({
      tag: "stable-20260907",
      sha: "deadbeef",
      previousTag: "stable-20260906",
      delta,
      atIso: "2026-09-07T12:00:00.000Z",
    });
    expect(rec).toMatchObject({
      kind: "recovery-promotion",
      tag: "stable-20260907",
      sha: "deadbeef",
      rollbackTag: "stable-20260906",
      sweepOwed: true,
      sweptBy: null,
    });
    expect(rec.delta).toMatchObject({ commitCount: 1, fileCount: 1, migrations: [] });
  });
});

describe("recovery lane: it is not the force-sweep path", () => {
  it("acquires no sweep, and says why in its own words", () => {
    const acq = planSweepAcquisition({
      verdict: { ok: true, reason: "recovery", sha: null, detail: "--recover: the sweep was not consulted" },
      recover: true,
    });
    expect(acq.request).toBe(false);
    expect(acq.reason).toBe("recover");
    expect(acq.detail).toContain("--recover");
    expect(acq.detail).not.toContain("--force-sweep");
  });

  it("makes step 1 describe the lane that actually ran, not a sweep check that did not", () => {
    const plan = buildPromotionPlan({
      sha: "abc1234",
      tag: "stable-20260907",
      previousTag: "stable-20260906",
      stableCheckout: "/stable",
      repoRoot: "/repo",
      boardUrl: "http://127.0.0.1:3001",
      dbPath: "/db",
      sweepSource: "SKIPPED (--recover)",
      sweepVerdict: "not consulted",
      projectName: "agentic-kanban",
      stablePort: 3001,
      dbUrl: "file:/db",
      logPath: "/stable/.kanban/promote.log",
      recovery: "RECOVERY (reversible): 2 commit(s), 3 file(s), no migrations",
    });
    expect(plan[0].title).toContain("--recover");
    expect(plan[0].title).not.toContain("was green");
    expect(plan[0].detail).toContain("roll back automatically");
  });
});
