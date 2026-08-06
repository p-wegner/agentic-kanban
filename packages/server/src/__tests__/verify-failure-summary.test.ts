// #221: the stored pre-merge-gate error used to be the first ~300 chars of the verify
// output — entirely consumed by git-init hints and CRLF warnings emitted by test fixtures,
// so the actual test failure was never visible and diagnosing a red gate meant re-running a
// 20+ minute suite by hand. The summary must keep the (noise-filtered) TAIL, where vitest
// prints its failures and summary, and reference a persisted full log.
import { describe, expect, it } from "vitest";
import { summarizeVerifyFailure } from "../services/pre-merge-gate.service.js";

const GIT_NOISE = [
  "hint: Using 'master' as the name for the initial branch. This default branch name",
  'hint: will change to "main" in Git 3.0. To configure the initial branch name',
  "hint: to use in all of your new repositories, which will suppress this warning,",
  "hint:",
  "hint: \tgit config --global init.defaultBranch <name>",
  "warning: in the working copy of '.gitignore', LF will be replaced by CRLF the next time Git touches it",
].join("\n");

const VITEST_TAIL = [
  " FAIL  src/__tests__/foo.test.ts > foo > does the thing",
  "AssertionError: expected 2 to be 3",
  " Test Files  1 failed (12)",
  "      Tests  1 failed | 87 passed (88)",
].join("\n");

describe("summarizeVerifyFailure (#221)", () => {
  it("keeps the failure tail instead of leading git noise, and references the full log", () => {
    const stdout = `${GIT_NOISE}\n${"x".repeat(4000)}\n${VITEST_TAIL}`;
    const summary = summarizeVerifyFailure(stdout, "", "ws-221", () => "/tmp/kanban-verify-ws-221.log");

    expect(summary).toContain("AssertionError: expected 2 to be 3");
    expect(summary).toContain("Tests  1 failed");
    expect(summary).not.toContain("git config --global init.defaultBranch");
    expect(summary).toContain("[full verify log: /tmp/kanban-verify-ws-221.log]");
  });

  it("filters hint:/CRLF-warning lines even when they are all there is at the tail", () => {
    const summary = summarizeVerifyFailure(`real failure line\n${GIT_NOISE}`, "", "ws-221", () => null);
    expect(summary.trim()).toBe("real failure line");
  });

  it("falls back to the unfiltered output when filtering would leave nothing", () => {
    const summary = summarizeVerifyFailure(GIT_NOISE, "", "ws-221", () => null);
    expect(summary).toContain("hint:");
  });

  it("prefers stderr content ahead of stdout in the combined stream", () => {
    const summary = summarizeVerifyFailure("stdout says ok-ish", "stderr says broken", "ws-221", () => null);
    expect(summary.indexOf("stderr says broken")).toBeLessThan(summary.indexOf("stdout says ok-ish"));
  });

  it("survives a log-write failure without losing the summary", () => {
    const summary = summarizeVerifyFailure(VITEST_TAIL, "", "ws-221", () => {
      throw new Error("disk full");
    });
    expect(summary).toContain("AssertionError");
    expect(summary).not.toContain("full verify log");
  });
});
