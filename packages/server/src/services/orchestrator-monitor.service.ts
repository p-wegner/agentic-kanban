// Read-only observability for the detached board-monitor *orchestrator* loop
// (scripts/board-monitor/, see docs/decisions/006-board-monitor-orchestrator-architecture.md).
//
// This is the dogfooding control plane for THIS repo: a fresh `codex exec` board
// monitor every ~5 min, whose durable state lives on disk in the project's
// `scripts/board-monitor/` dir (loop.pid / state.md / loop.log). We surface that
// here so the board can show "is the orchestrator alive and what did it just do?".
//
// Naturally gated: a project whose repo has no `scripts/board-monitor/loop.sh`
// (i.e. every project EXCEPT this one) reports `available: false`, so the UI strip
// simply doesn't render for normal installs that use the in-process monitor.

import { existsSync, statSync, openSync, readSync, closeSync, readFileSync } from "fs";
import { join } from "path";

// A healthy loop sleeps MONITOR_SLEEP (default 300s) between iterations and streams
// output during each one, so loop.log is touched at least every few minutes. If it
// has been silent longer than this, the driver is dead or wedged. (We can't use
// loop.pid for liveness: loop.sh logs the MSYS/Git-bash `$$`, not a Windows PID, so
// Node's process.kill checks the wrong PID namespace and always reports dead.)
const ALIVE_STALENESS_MS = 11 * 60 * 1000;

export interface OrchestratorStatus {
  available: boolean;
  /** Driver considered alive iff loop.log was written within ALIVE_STALENESS_MS. */
  alive: boolean;
  pid: number | null;
  /** ISO timestamp loop.log was last written (freshness / "last activity"). */
  lastLogAt: string | null;
  /** ISO timestamp of the most recent iteration boundary seen in loop.log. */
  lastEventAt: string | null;
  /** Current/last iteration number. */
  iteration: number | null;
  /** "running" if the last boundary was a START with no matching END, else "idle". */
  phase: "running" | "idle" | "unknown";
  /** Exit code of the last completed iteration (124 = hit the 30-min cap). */
  lastExit: number | null;
  /** Duration in seconds of the last completed iteration. */
  lastDurationSec: number | null;
  /** Most recent cycle-summary lines from state.md (newest last), comments stripped. */
  recentCycles: string[];
}

// Strip stray NUL bytes (U+0000) that interleaved process output leaves in loop.log.
const NUL = new RegExp(String.fromCharCode(0), "g");

const UNAVAILABLE: OrchestratorStatus = {
  available: false,
  alive: false,
  pid: null,
  lastLogAt: null,
  lastEventAt: null,
  iteration: null,
  phase: "unknown",
  lastExit: null,
  lastDurationSec: null,
  recentCycles: [],
};

/** Read at most the last `maxBytes` of a (possibly huge) file as UTF-8. */
function readTail(path: string, maxBytes: number): string {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    if (len <= 0) return "";
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, start);
    // loop.log can contain stray NUL bytes from interleaved output — strip them.
    return buf.toString("utf8").replace(NUL, "");
  } catch {
    return "";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

interface IterationBoundary {
  ts: string;
  iter: number;
  kind: "START" | "END";
  exit?: number;
  dur?: number;
}

/**
 * Find the most recent `--- iteration N START|END ---` boundary in loop.log,
 * escalating the tail read through `sizes` until one is found (or all sizes are
 * <= the previous full-file read). Returns null if no boundary exists.
 */
function findLastIteration(logPath: string, sizes: number[]): IterationBoundary | null {
  let prevLen = -1;
  for (const size of sizes) {
    const tail = readTail(logPath, size);
    if (tail.length <= prevLen) break; // already read the whole file, no point growing
    prevLen = tail.length;
    // Local regex so its lastIndex can't leak across iterations/calls.
    const re = /\[([^\]]+)\] --- iteration (\d+) (START|END)(?: exit=(\d+) dur=(\d+)s)? ---/g;
    let m: RegExpExecArray | null;
    let last: IterationBoundary | null = null;
    while ((m = re.exec(tail)) !== null) {
      last = {
        ts: m[1],
        iter: Number.parseInt(m[2], 10),
        kind: m[3] as "START" | "END",
        exit: m[4] !== undefined ? Number.parseInt(m[4], 10) : undefined,
        dur: m[5] !== undefined ? Number.parseInt(m[5], 10) : undefined,
      };
    }
    if (last) return last;
  }
  return null;
}

/**
 * Read the orchestrator loop's on-disk state for a project repo. Pure reads — no
 * process spawn, no writes. Returns `available: false` when the repo has no loop.
 */
export function readOrchestratorStatus(
  repoPath: string,
  opts: { recentLimit?: number } = {}
): OrchestratorStatus {
  if (!repoPath) return UNAVAILABLE;
  const dir = join(repoPath, "scripts", "board-monitor");
  if (!existsSync(join(dir, "loop.sh"))) return UNAVAILABLE;

  const recentLimit = Math.min(40, Math.max(1, opts.recentLimit ?? 12));

  // --- pid (display only) ---
  let pid: number | null = null;
  const pidPath = join(dir, "loop.pid");
  if (existsSync(pidPath)) {
    const parsed = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
    if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
  }

  // --- driver liveness (loop.log freshness, not pid — see ALIVE_STALENESS_MS) ---
  const logPath = join(dir, "loop.log");
  let lastLogAt: string | null = null;
  let alive = false;
  if (existsSync(logPath)) {
    try {
      const mtime = statSync(logPath).mtime;
      lastLogAt = mtime.toISOString();
      alive = Date.now() - mtime.getTime() < ALIVE_STALENESS_MS;
    } catch {
      /* ignore */
    }
  }

  // --- last iteration boundary (tail of loop.log) ---
  let lastEventAt: string | null = null;
  let iteration: number | null = null;
  let phase: OrchestratorStatus["phase"] = "unknown";
  let lastExit: number | null = null;
  let lastDurationSec: number | null = null;

  // A single cycle can stream multiple MB of agent output between two iteration
  // boundaries, so escalate the tail size until we find the last START/END (capped).
  // Most polls (sleeping / short cycles) resolve at the small size; only a long
  // in-flight cycle pays the larger read.
  const last = findLastIteration(logPath, [1024 * 1024, 8 * 1024 * 1024]);
  if (last) {
    lastEventAt = last.ts;
    iteration = last.iter;
    phase = last.kind === "START" ? "running" : "idle";
    if (last.kind === "END") {
      lastExit = last.exit ?? null;
      lastDurationSec = last.dur ?? null;
    }
  }

  // --- recent cycle summaries (state.md) ---
  let recentCycles: string[] = [];
  const statePath = join(dir, "state.md");
  if (existsSync(statePath)) {
    recentCycles = readFileSync(statePath, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"))
      .slice(-recentLimit);
  }

  return {
    available: true,
    alive,
    pid,
    lastLogAt,
    lastEventAt,
    iteration,
    phase,
    lastExit,
    lastDurationSec,
    recentCycles,
  };
}
