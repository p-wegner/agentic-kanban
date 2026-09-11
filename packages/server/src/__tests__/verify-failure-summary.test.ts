// #221: the stored pre-merge-gate error used to be the first ~300 chars of the verify
// output — entirely consumed by git-init hints and CRLF warnings emitted by test fixtures,
// so the actual test failure was never visible and diagnosing a red gate meant re-running a
// 20+ minute suite by hand. The summary must keep the (noise-filtered) TAIL, where vitest
// prints its failures and summary, and reference a persisted full log.
import { describe, expect, it } from "vitest";
import { looksLikeMissingDepsFailure, summarizeVerifyFailure } from "../services/pre-merge-gate.service.js";

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

// #1092: a worktree whose install never completed failed `check:arch` with a LOCALIZED cmd.exe
// "command not found", and the gate summary led with pnpm's deprecation notice instead of it.
const PNPM_FIELD_WARN =
  '[WARN] The "pnpm" field in package.json is no longer read by pnpm. The following keys were ignored: "pnpm.onlyBuiltDependencies". See https://pnpm.io/settings for the new home of each setting.';
const GERMAN_COMMAND_NOT_FOUND = [
  'Der Befehl "depcruise" ist entweder falsch geschrieben oder',
  "konnte nicht gefunden werden.",
  "[check:arch] FAILED at lint:arch",
].join("\n");

describe("summarizeVerifyFailure — pnpm deprecation notice is noise (#1092)", () => {
  it("does not lead the summary with pnpm's `pnpm`-field warning", () => {
    const summary = summarizeVerifyFailure("", `${PNPM_FIELD_WARN}\n${GERMAN_COMMAND_NOT_FOUND}`, "ws-1092", () => null);
    expect(summary).not.toContain('The "pnpm" field');
    expect(summary.startsWith('Der Befehl "depcruise"')).toBe(true);
  });
});

describe("looksLikeMissingDepsFailure — localized cmd.exe command-not-found (#1092)", () => {
  it("recognizes the German wording, which cmd.exe splits across two lines", () => {
    expect(looksLikeMissingDepsFailure(`${PNPM_FIELD_WARN}\n${GERMAN_COMMAND_NOT_FOUND}`)).toBe(true);
  });

  it("still recognizes the English wording", () => {
    expect(looksLikeMissingDepsFailure("'depcruise' is not recognized as an internal or external command,")).toBe(true);
  });

  it("does not treat an ordinary test failure as missing dependencies", () => {
    expect(looksLikeMissingDepsFailure(VITEST_TAIL)).toBe(false);
  });
});

// #490: a crashed vitest worker fork reports ZERO failing tests and a passing-looking summary
// at the very end of the log — the tail-only summary above reads this as success. The crash
// verdict (and which file never reported) must be classified distinctly and LEAD the message.
const CRASH_LOG = [
  "Unhandled Rejection",
  "Error: Worker exited unexpectedly (SIGSEGV)",
  '  at ChildProcess.<anonymous> (file:///repo/node_modules/vitest/dist/worker.js:88:11)',
  'This error originated in "src/services/foo.test.ts" test file. It doesn\'t mean the error was thrown inside the file itself, but while it was running.',
  "panicked at 'index out of bounds'",
  "",
  "Test Files  565 passed (566)",
  "     Tests  5132 passed | 4 skipped (5146)",
  "    Errors  1 error",
].join("\n");

describe("summarizeVerifyFailure — worker crash with zero failures (#490)", () => {
  it("leads with the crash and names the missing file instead of the passing summary", () => {
    const summary = summarizeVerifyFailure(CRASH_LOG, "", "ws-490", () => null);
    expect(summary.startsWith("CRASH:")).toBe(true);
    expect(summary).toContain("src/services/foo.test.ts");
    expect(summary.indexOf("CRASH:")).toBeLessThan(summary.indexOf("565 passed"));
  });

  it("surfaces the Errors line and the crash marker line", () => {
    const summary = summarizeVerifyFailure(CRASH_LOG, "", "ws-490", () => null);
    expect(summary).toContain("Errors  1 error");
    expect(summary).toMatch(/worker exited unexpectedly/i);
  });

  it("does not classify a real test failure (nonzero 'failed' count) as a crash", () => {
    const summary = summarizeVerifyFailure(VITEST_TAIL, "", "ws-221", () => null);
    expect(summary.startsWith("CRASH:")).toBe(false);
  });

  it("reports an unnamed missing-file count when no per-file attribution is in the log", () => {
    const noAttribution = [
      "Test Files  565 passed (566)",
      "     Tests  5132 passed | 4 skipped (5146)",
      "    Errors  1 error",
    ].join("\n");
    const summary = summarizeVerifyFailure(noAttribution, "", "ws-490b", () => null);
    expect(summary.startsWith("CRASH:")).toBe(true);
    expect(summary).toContain("1 of 566 test file(s) never reported a result");
  });
});
