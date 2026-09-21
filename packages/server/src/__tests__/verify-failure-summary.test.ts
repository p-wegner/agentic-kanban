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

// #1149: a worktree with no `typescript` installed made the god-module gate fall back to a
// regex heuristic for its cohesion count, which reported a violation that did not exist — and
// the resulting gate message read exactly like a real architecture-violation refusal, with
// nothing pointing at the actual cause. `check-god-modules.mjs` now prints its own distinct
// "UNVERIFIED" self-report when this happens; the summary must lead with it, ahead of the raw
// gate output, rather than let it read as an ordinary red gate.
const GOD_MODULE_DEGRADED_LOG = [
  "[god-module gate] 1 module(s) declare more than 20 top-level functions/classes (exported + internal) — a low-cohesion god-module smell (#889), UNVERIFIED — typescript is not installed, so this count used a regex heuristic and cannot be trusted as a real violation.",
  "Split by responsibility into cohesive sub-modules re-exported through a facade barrel:",
  "  packages/shared/src/lib/__cohesion_probe__.ts  (21 lines, 21 functions/classes)",
  "",
  "[god-module gate] UNVERIFIED — typescript is not installed in this worktree, so the cohesion count above is a regex guess and cannot be treated as a real violation. Run `pnpm install -r` in this worktree and re-run the gate for a trustworthy verdict.",
].join("\n");

describe("summarizeVerifyFailure — god-module gate degraded to a regex heuristic (#1149)", () => {
  it("leads with UNVERIFIED (degraded) instead of reading as an ordinary red gate", () => {
    const summary = summarizeVerifyFailure(GOD_MODULE_DEGRADED_LOG, "", "ws-1149", () => null);
    expect(summary.startsWith("UNVERIFIED (degraded):")).toBe(true);
    expect(summary).toMatch(/typescript.*is not installed/i);
    expect(summary).toContain("pnpm install -r");
  });

  it("still includes the raw gate output after the lead line, so a real co-occurring failure is visible", () => {
    const summary = summarizeVerifyFailure(GOD_MODULE_DEGRADED_LOG, "", "ws-1149", () => null);
    expect(summary).toContain("__cohesion_probe__.ts");
  });

  it("does not fire on an ordinary passing/failing gate with no degradation marker", () => {
    const summary = summarizeVerifyFailure(VITEST_TAIL, "", "ws-221", () => null);
    expect(summary.startsWith("UNVERIFIED (degraded):")).toBe(false);
  });

  it("takes precedence over the crash detector when both markers happen to be present", () => {
    const combined = `${GOD_MODULE_DEGRADED_LOG}\n${CRASH_LOG}`;
    const summary = summarizeVerifyFailure(combined, "", "ws-1149b", () => null);
    expect(summary.startsWith("UNVERIFIED (degraded):")).toBe(true);
  });
});

// #1218: a train's staging gate (test:mine, run once per package) can fail an EARLY package and
// then print every later package's PASSING summary after it — so the bounded TAIL, which is all
// that used to get persisted, contained nothing but "Test Files N passed (N)" repeated for
// package after package, and the real `FAIL`/assertion line was truncated away entirely. A red
// train bisected two members out this way with a stored reason that named no failing test.
describe("summarizeVerifyFailure — a failing line pushed out of the tail by later passing packages (#1218)", () => {
  const FAILING_PACKAGE = [
    " FAIL  src/__tests__/openapi-request-body-ratchet.test.ts (#838)",
    "AssertionError: expected true to be false",
    " Test Files  1 failed (12)",
    "      Tests  1 failed | 87 passed (88)",
  ].join("\n");
  // Enough trailing passing-package noise to push FAILING_PACKAGE outside the last
  // VERIFY_FAILURE_TAIL_CHARS (1500) characters.
  const trailingPassingPackages = Array.from(
    { length: 20 },
    (_, i) => ` Test Files  ${i + 1} passed (${i + 1})\n      Tests  ${i + 1} passed (${i + 1})`,
  ).join("\n".repeat(20));

  it("surfaces the failing test name and a log path even though it fell out of the tail", () => {
    const stdout = `${FAILING_PACKAGE}\n${trailingPassingPackages}`;
    const summary = summarizeVerifyFailure(stdout, "", "train-ws-1218", () => "/tmp/kanban-verify-train-ws-1218.log");

    expect(summary).toContain("openapi-request-body-ratchet.test.ts");
    expect(summary).toContain("[full verify log: /tmp/kanban-verify-train-ws-1218.log]");
  });

  it("does not fire when the tail itself already shows a failure line", () => {
    const summary = summarizeVerifyFailure(FAILING_PACKAGE, "", "ws-1218b", () => null);
    // The failure line is well within the (short, unpadded) tail here, so no recovery is needed.
    expect(summary).not.toContain("earlier in the log than the kept tail");
    expect(summary).toContain("openapi-request-body-ratchet.test.ts");
  });

  it("leaves an opaque log (no known failure shape anywhere) exactly as before", () => {
    // Nothing here matches FAILURE_LINE_SIGNATURE anywhere in the body — that is a message in a
    // shape this detector doesn't recognise (a foreign verify_script, a lint tool), not a case of
    // truncation hiding a real failure line, so it must not claim otherwise.
    const opaque = `some non-matching diagnostic output\n${"y".repeat(4000)}\nmore non-matching output`;
    const summary = summarizeVerifyFailure(opaque, "", "ws-1218c", () => null);
    expect(summary).not.toContain("earlier in the log than the kept tail");
  });
});
