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
    .filter((line) => !BENIGN_GIT_NOISE.test(line))
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
  const crash = detectVerifyCrash(body);
  const message = crash ? `${crash.leadLine}\n\n${tail}` : tail;
  return `${message}${logPath ? `\n[full verify log: ${logPath}]` : ""}`;
}

