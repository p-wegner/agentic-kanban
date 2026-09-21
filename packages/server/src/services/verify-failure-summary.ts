/**
 * How a FAILED verify run is turned into the message a human reads (#221/#490) — extracted
 * from pre-merge-gate.service.ts, which crossed the 1000-line god-module ceiling.
 *
 * Its own cohesive job: strip the benign noise that reliably occupies the front of the stream,
 * keep a bounded TAIL rather than a head slice, and lift a worker CRASH verdict out of the
 * middle of the log to the front — because a crashed run's tail ends with a passing-looking
 * summary, so the honest verdict is the one thing truncation used to remove.
 */
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Lines in a verify run's output that carry ZERO diagnostic value but reliably occupy the
 * FRONT of the stream (#221): `git init` default-branch hints and CRLF warnings emitted by
 * test fixtures. When the stored gate error was a head slice, these consumed the entire
 * budget and the actual test failure was never visible.
 */
const BENIGN_GIT_NOISE = /^\s*(hint:|warning: in the working copy of .+ (LF|CRLF) will be replaced|warning: (LF|CRLF) will be replaced)/i;

/**
 * pnpm's deprecation notice for the `pnpm` field in package.json (#1092). Every `pnpm` invocation
 * prints it FIRST, so it became the headline of every failed gate — "verify_script failed (exit 1):
 * [WARN] The "pnpm" field…" — while the line that named the cause (`depcruise` not found) sat below it.
 */
const BENIGN_PNPM_NOISE = /^\s*\[WARN\] The "pnpm" field in package\.json is no longer read by pnpm\b/i;

/** How many chars of (noise-filtered) TAIL to keep in the stored gate message (#221). */
const VERIFY_FAILURE_TAIL_CHARS = 1500;

/**
 * Markers of the runner ITSELF crashing (a worker fork died, an unhandled rejection escaped,
 * the process aborted) rather than a test assertion failing (#490). A crash like this reports
 * zero "failed" tests — the suite mid-crash never got to report a result — so a summary that
 * only ever surfaces "N failed" reads as a clean pass when a worker actually died mid-run.
 */
const WORKER_CRASH_SIGNATURE =
  /unhandled (rejection|error|exception)|panicked at|segmentation fault|fatal error|worker (process )?(exited|died|crashed)|terminated unexpectedly|failed to terminate worker|channel closed|out of memory|uncaught exception/i;

/** Vitest's own attribution line for an error that killed a worker mid-file (#490). */
const ORIGINATED_IN_FILE = /originated in ["']([^"']+)["'] test file/gi;

/** Parses vitest's `Test Files  N passed | M failed (T)` summary line, if present. */
function parseTestFilesSummary(body: string): { reported: number; failed: number; total: number } | null {
  const line = body.split(/\r?\n/).find((l) => /^\s*Test Files\b/i.test(l));
  if (!line) return null;
  const totalMatch = line.match(/\((\d+)\)/);
  if (!totalMatch) return null;
  const total = Number.parseInt(totalMatch[1], 10);
  let reported = 0;
  let failed = 0;
  for (const m of line.matchAll(/(\d+)\s+(passed|failed|skipped|todo)/gi)) {
    const count = Number.parseInt(m[1], 10);
    reported += count;
    if (m[2].toLowerCase() === "failed") failed = count;
  }
  return { reported, failed, total };
}

/**
 * A verdict line — something in the output showing a CHECK actually reached a conclusion.
 *
 * `check-arch.mjs` prints `[check:arch] FAILED at <step>`, `tsc` prints `error TS...`, vitest
 * prints a `Test Files`/`Tests` summary or an `AssertionError`. A non-zero run carrying none
 * of these AND no `[gate:step]` marker never got far enough to report anything — a different
 * event from failing, and one that needs saying so.
 */
const VERIFY_VERDICT_SIGNATURE =
  /^\s*(\[check:arch\]\s+FAILED|Test Files\b|Tests\s+\d|AssertionError|.*\berror TS\d+\b|.*ELIFECYCLE.*ommand failed)/m;

/** The per-step self-report every verify step in this repo emits when it completes. */
const GATE_STEP_LINE = /^\s*\[gate:step\]\s/m;

/**
 * The scripts that PROMISE a `[gate:step]` line when they finish.
 *
 * Without this, the absence of a step marker means nothing: a foreign project's verify script
 * (`npm test`, `pytest`, `./gradlew build`) never emits one, so every ordinary failure there
 * would be mislabelled "stopped". The detector may therefore only speak when the output shows
 * one of these was actually invoked — i.e. when the missing self-report is genuinely missing
 * rather than never promised. Caught by `verify-failure-summary.test.ts`'s existing cases,
 * which a first cut of this turned red.
 */
const STEP_EMITTING_SCRIPT = /scripts[\\/](check-arch|typecheck|test-mine)\.mjs/;

/**
 * Detects a verify run that STOPPED rather than failed (#1049).
 *
 * The shape, measured repeatedly on 2026-09-05: a few hundred bytes of captured output ending
 * under a command's own banner — `> node scripts/check-arch.mjs`, the first sub-step's line,
 * nothing more — with a non-zero exit, no `[gate:step]` marker from any step, and no verdict
 * line from any check. The identical script run by hand in the same worktree was green. So the
 * script did not fail a check; it died inside its first step before that step could report,
 * and the gate presented the resulting stub as if it were the failure. Four merges were
 * withheld that way, each reading as "check:arch failed" when check:arch passes.
 *
 * Deliberately conservative: it requires the ABSENCE of every verdict signature, so a real
 * failure can never be relabelled as this. When it fires it states what is and is not known,
 * because the thing that must not happen again is a stub being read as a diagnosis.
 */
function detectSilentVerifyDeath(body: string): { leadLine: string } | null {
  if (!body.trim()) return null;
  // The step protocol must have been in play, or a missing step line proves nothing.
  if (!STEP_EMITTING_SCRIPT.test(body)) return null;
  if (GATE_STEP_LINE.test(body)) return null;
  if (VERIFY_VERDICT_SIGNATURE.test(body)) return null;

  const lines = body.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
  const lastLine = lines[lines.length - 1] ?? "";
  return {
    leadLine:
      "STOPPED, NOT FAILED: the verify script exited non-zero having emitted no [gate:step] " +
      "marker and no verdict from any check, so nothing it ran reported a result. The output " +
      `below is WHERE it stopped, not WHY. Last line captured: ${JSON.stringify(lastLine)}. ` +
      "This is the shape of a child killed mid-step (host memory pressure is the known cause " +
      "here) — it is NOT evidence that the command named above failed its check. Re-run the " +
      "same script in the worktree before believing this failure.",
  };
}

/**
 * The god-module gate's own self-report when it degraded to a regex heuristic because
 * `typescript` was not installed in the worktree (#1149) — `scripts/check-god-modules.mjs`
 * prints this verbatim and exits a distinct code (3) rather than 1 when a cohesion finding was
 * the ONLY reason it would otherwise fail.
 */
const GOD_MODULE_GATE_DEGRADED_SIGNATURE = /\[god-module gate\]\s+UNVERIFIED\s+—\s+typescript is not installed/i;

/**
 * Detects the #1149 shape: a worktree whose `node_modules` never got `typescript` installed
 * made the god-module gate fall back to a regex heuristic for its cohesion count, and that
 * heuristic can misjudge a file's declaration count. Reporting the resulting finding as an
 * ordinary red gate is indistinguishable from a real architecture violation — a builder was
 * once told to fix a ceiling breach that did not exist while the branch's REAL problem (a
 * genuine complexity regression) went unmentioned. This must lead the message, ahead of the
 * raw gate output, so "typescript is missing, install it" is the first thing read rather than
 * something a human has to notice buried in the tail.
 */
function detectGodModuleGateDegraded(body: string): { leadLine: string } | null {
  if (!GOD_MODULE_GATE_DEGRADED_SIGNATURE.test(body)) return null;
  return {
    leadLine:
      "UNVERIFIED (degraded): the god-module gate could not verify this worktree — `typescript` " +
      "is not installed, so its cohesion count fell back to a regex heuristic that can misjudge " +
      "a file's finding. This is NOT proof of an architecture violation. Run `pnpm install -r` " +
      "in this worktree and re-run the gate for a trustworthy verdict; any OTHER failure named " +
      "below (line ceiling, branch complexity) is unaffected and still real.",
  };
}

/**
 * A single line naming an actual failed check — the thing a human needs to see, as opposed to
 * a passing package's own summary line. Deliberately narrower than `VERIFY_VERDICT_SIGNATURE`
 * (which also matches a PASSING `Test Files`/`Tests` line, since it only needs to prove a check
 * concluded): this one only matches a line that says something failed.
 */
const FAILURE_LINE_SIGNATURE =
  /^\s*(?:FAIL\b|\s*×\s|AssertionError|.*\berror TS\d+\b|\[check:arch\]\s+FAILED|\[god-module gate\](?!.*\bOK\b)|.*ELIFECYCLE.*ommand failed)/m;

/**
 * Detects a real failure line that the bounded TAIL dropped (#1218): `test:mine` runs one
 * `vitest` invocation PER PACKAGE, so a multi-package verify run prints one `Test Files`/`Tests`
 * summary per package, in package order — not necessarily the order the failure happened in. A
 * failure in an EARLY package is followed by every later package's PASSING summary, so by the
 * time the tail keeps its last `VERIFY_FAILURE_TAIL_CHARS`, nothing readable survives: a train
 * bisected two members out on `reason: "Test Files 44 passed (44) … Test Files 195 passed
 * (195)"` — a red gate whose stored reason named no failing test at all.
 *
 * Conservative like the other detectors here: it only fires when the TAIL itself carries none of
 * the failure-line shapes, so a tail that already shows the real failure (the common case) is
 * left alone — this only recovers the case where truncation ate the only evidence.
 */
function detectFailureLinesOutsideTail(body: string, tail: string): { leadLine: string } | null {
  if (FAILURE_LINE_SIGNATURE.test(tail)) return null;
  const failureLines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && FAILURE_LINE_SIGNATURE.test(l));
  // Nothing recognisable ANYWHERE in the log is not this detector's case — that is an ordinary
  // message in a shape this file doesn't specifically know (a foreign verify_script, a lint
  // error, a shell error), not a failure that truncation hid. Say nothing rather than claim "no
  // failure line matched" about a message that was never a test/build failure line to begin with.
  if (failureLines.length === 0) return null;
  const unique = Array.from(new Set(failureLines)).slice(0, 20);
  return {
    leadLine:
      "the failing check(s), pulled from earlier in the log than the kept tail below (a later " +
      "package's PASSING summary pushed them out of the truncation window):\n" +
      unique.join("\n"),
  };
}

/**
 * Detects a runner CRASH distinct from a real test failure (#490): a non-zero exit whose
 * `Test Files` summary names ZERO failures (or reports fewer files than it started with, or
 * carries a worker-crash marker) — the shape that reads as "flaky, just retry" when it is
 * actually a dead worker that silently ate one or more suites. Never fires when the summary
 * already names real failures — those are a genuine red gate, not this distinct case.
 */
function detectVerifyCrash(body: string): { leadLine: string } | null {
  const summary = parseTestFilesSummary(body);
  if (summary && summary.failed > 0) return null;
  const missing = summary ? summary.total - summary.reported : 0;
  const hasCrashMarker = WORKER_CRASH_SIGNATURE.test(body);
  const errorsLineMatch = body.match(/^\s*Errors\s+(\d+)\s+error/im);
  const hasErrorsLine = Boolean(errorsLineMatch && Number.parseInt(errorsLineMatch[1], 10) > 0);
  if (missing <= 0 && !hasCrashMarker && !hasErrorsLine) return null;

  const namedFiles = Array.from(new Set(Array.from(body.matchAll(ORIGINATED_IN_FILE), (m) => m[1])));
  const parts = ["CRASH: the test runner did not complete normally — this is NOT a clean test failure."];
  if (missing > 0) {
    parts.push(
      namedFiles.length > 0
        ? `${missing} of ${summary!.total} test file(s) never reported a result, including: ${namedFiles.join(", ")}.`
        : `${missing} of ${summary!.total} test file(s) never reported a result (unnamed — no per-file attribution found in the log).`,
    );
  } else if (namedFiles.length > 0) {
    parts.push(`Crash attributed to: ${namedFiles.join(", ")}.`);
  }
  if (hasErrorsLine) parts.push(errorsLineMatch![0].trim());
  if (hasCrashMarker) {
    const markerLine = body.split(/\r?\n/).find((l) => WORKER_CRASH_SIGNATURE.test(l));
    if (markerLine) parts.push(markerLine.trim());
  }
  return { leadLine: parts.join(" ") };
}

/**
 * Build the human-facing summary of a failed verify run (#221): filter known-benign git
 * noise, keep the TAIL (vitest prints failures and its summary at the END), and persist the
 * FULL untruncated output to a log file whose path the message references — so the gate is
 * diagnosable without re-running a 20+ minute suite.
 */
export function summarizeVerifyFailure(
  stdout: string,
  stderr: string,
  workspaceId: string,
  writeLog: (content: string) => string | null = (content) => {
    try {
      // Deterministic per workspace (no timestamp): the latest failure overwrites, and the
      // resulting message stays STABLE so recordGateFailureNote's dedup-by-gateMessage (#170)
      // still recognises an unchanged failure repeating across orchestrator ticks.
      const path = join(tmpdir(), `kanban-verify-${workspaceId}.log`);
      writeFileSync(path, content, "utf8");
      return path;
    } catch {
      return null;
    }
  },
): string {
  const combined = [stderr, stdout].filter(Boolean).join("\n");
  let logPath: string | null = null;
  if (combined) {
    try {
      logPath = writeLog(combined);
    } catch {
      logPath = null;
    }
  }
  const filtered = combined
    .split(/\r?\n/)
    .filter((line) => !BENIGN_GIT_NOISE.test(line) && !BENIGN_PNPM_NOISE.test(line))
    .join("\n")
    .trim();
  const body = filtered || combined.trim();
  const tail = body.length > VERIFY_FAILURE_TAIL_CHARS
    ? `…${body.slice(-VERIFY_FAILURE_TAIL_CHARS)}`
    : body;
  // #490: a worker crash's diagnostic lines (unhandled-error markers, the file it was attributed
  // to) can occur ANYWHERE in the log, not just the tail, and the tail itself ends with a
  // passing-looking summary. Lift the crash verdict OUT and put it FIRST, ahead of that summary,
  // instead of leaving it to be scrolled past or truncated away entirely.
  // Order matters: the god-module degradation is checked FIRST — it is a distinct, self-declared
  // signal (`[god-module gate] UNVERIFIED`, #1149) rather than an inference from shape the way
  // the crash/silent-death detectors below are, so it should never be shadowed by either. A
  // worker crash is a run that got far enough to report SOMETHING, so it is the more specific
  // verdict of the remaining two and wins; `detectSilentVerifyDeath` is the fallback for a run
  // that reported nothing at all. `detectFailureLinesOutsideTail` runs LAST and only when none of
  // the above fired: it is the most conservative of the four (it only speaks when the tail is
  // silent about failure lines that DO exist earlier in the log), so it must never shadow a more
  // specific verdict — including the ordinary case where the tail already shows the failure.
  const crash =
    detectGodModuleGateDegraded(body) ??
    detectVerifyCrash(body) ??
    detectSilentVerifyDeath(body) ??
    detectFailureLinesOutsideTail(body, tail);
  const message = crash ? `${crash.leadLine}\n\n${tail}` : tail;
  return `${message}${logPath ? `\n[full verify log: ${logPath}]` : ""}`;
}

