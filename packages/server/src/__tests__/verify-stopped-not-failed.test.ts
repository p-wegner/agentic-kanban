/**
 * #1049: a withheld merge that says "check:arch failed" when check:arch passes.
 *
 * Measured 2026-09-05 across four gate runs on three workspaces: the gate captured a few
 * hundred bytes ending under `> node scripts/check-arch.mjs` plus that script's first
 * sub-step line, exited non-zero, and the message presented that stub as the failure. The
 * identical verify script, run by hand in the same worktree, was green every time — so the
 * script had not failed a check, it had stopped inside its first step.
 *
 * The distinguishing signal is the ABSENCE of two things the repo already emits: a
 * `[gate:step]` self-report from any completed step, and a verdict line from any check.
 * These tests pin both the firing case and — more importantly — the cases where it must NOT
 * fire, because mislabelling a real failure as "stopped" would be worse than the bug.
 */
import { describe, it, expect } from "vitest";
import { summarizeVerifyFailure } from "../services/verify-failure-summary.js";

const noLog = () => null;
const summarize = (out: string) => summarizeVerifyFailure(out, "", "ws-1049", noLog);

/** The real capture, byte-for-byte in shape, from ak-1038's withheld merge. */
const STOPPED = `
> agentic-kanban@ check:arch C:\projects\andrena\.worktrees\agentic-kanban\ak-1038
> node scripts/check-arch.mjs

[god-module gate] OK — 1682 source files within thresholds; peak function branch complexity 41.
`.trim();

describe("summarizeVerifyFailure — stopped vs failed (#1049)", () => {
  it("labels a run that emitted no step marker and no verdict as STOPPED, not failed", () => {
    const msg = summarize(STOPPED);
    expect(msg).toContain("STOPPED, NOT FAILED");
    // It must say where it stopped, since that is the only fact available.
    expect(msg).toContain("god-module gate");
    // And it must not let the reader believe the named command failed its check.
    expect(msg).toContain("NOT evidence");
  });

  it("does NOT fire when check:arch actually reported a failure", () => {
    const msg = summarize(`${STOPPED}\n[check:arch] FAILED at god-modules`);
    expect(msg).not.toContain("STOPPED, NOT FAILED");
  });

  it("does NOT fire when a step completed and reported itself", () => {
    const msg = summarize(`${STOPPED}\n[gate:step] name=arch seconds=40`);
    expect(msg).not.toContain("STOPPED, NOT FAILED");
  });

  it("does NOT fire on a real test failure", () => {
    const msg = summarize(" Test Files  1 failed | 872 passed (873)\n      Tests  3 failed | 8577 passed");
    expect(msg).not.toContain("STOPPED, NOT FAILED");
  });

  it("does NOT fire on a typecheck failure", () => {
    const msg = summarize("src/services/foo.ts(74,15): error TS2304: Cannot find name 'Bar'.");
    expect(msg).not.toContain("STOPPED, NOT FAILED");
  });

  it("leaves the #490 worker-crash verdict in front when both could apply", () => {
    // A crash got far enough to report something, so it is the more specific verdict.
    const msg = summarize(" Test Files  873 passed (873)\n      Tests  8580 passed\n     Errors  1 error\nunhandled rejection");
    expect(msg).toContain("CRASH");
    expect(msg).not.toContain("STOPPED, NOT FAILED");
  });

  it("does not fire on empty output", () => {
    expect(summarize("")).not.toContain("STOPPED, NOT FAILED");
  });
  it("does NOT fire for a project whose verify script never promises a step marker", () => {
    // A foreign project (`npm test`, `pytest`, `./gradlew build`) emits no `[gate:step]` at
    // all, so absence proves nothing there. A first cut of this detector labelled every such
    // failure "stopped"; the existing #221 suite caught it.
    const msg = summarize(["> app@ test /repo", "> jest", "", "something went wrong"].join("\n"));
    expect(msg).not.toContain("STOPPED, NOT FAILED");
  });
});
