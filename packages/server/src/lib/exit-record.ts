/**
 * A durable record of how this process started and how it ended (#373).
 *
 * ── Why this exists ──
 *
 * The dev backend died unattended for 15+ minutes: nothing listening on 13001, no `tsx`/`vite`
 * process on the box, two live pipelines interrupted mid-flight, and **no evidence at all** to
 * diagnose it from. That absence of evidence is the actual defect. `tsx watch` restarts the server
 * dozens of times a day under ordinary file edits, so the interesting event — a restart that never
 * came back — is indistinguishable from the routine ones unless something writes it down. `[fatal]`
 * on stdout is not enough: stdout dies with the terminal.
 *
 * ── The design point that makes it diagnostic ──
 *
 * A START line is written as well as an EXIT line, and that pairing is the whole trick. Every exit
 * path Node can observe (signal, `process.exit`, uncaught exception, unhandled rejection) writes an
 * exit line — but the two most interesting deaths write NOTHING, because they never run JavaScript
 * again: an **OOM kill** and a `taskkill /F`. Those are exactly the candidates the ticket could not
 * choose between. So:
 *
 *   a start line followed by another start line, with no exit line between them
 *     => the previous process was KILLED without notice (OOM / hard kill / power loss)
 *
 *   a start line with a matching exit line
 *     => an ordinary, explained shutdown; the line says which signal or code
 *
 * That is a decision procedure, not a log. Memory figures ride along on both kinds of line so the
 * OOM hypothesis can be judged from the trend approaching the gap rather than guessed at.
 *
 * ── The correction that makes the above usable at all ──
 *
 * The first version of this module shipped with only those two record kinds, and reading its own live
 * output within the hour showed the design was broken in practice: **five consecutive `start` records
 * with no exit record between any of them.** The dev server runs under a watch/restart wrapper that
 * KILLS the child rather than signalling it, so on this platform an ordinary file-edit reload produces
 * the identical signature to an OOM kill. An indicator that fires on every routine event is exactly as
 * useless as one that never fires — the same failure #374/#375 were about, in the other direction.
 *
 * A HEARTBEAT is what separates them, and it is the figure the ticket actually asked for. The process
 * overwrites a single-line "alive at T" file every {@link HEARTBEAT_INTERVAL_MS}; the next process
 * reads the stale one and can state the OUTAGE:
 *
 *   last alive T1, next process started T2  =>  the board was DOWN for T2 - T1
 *
 * A watch reload gives seconds. The event that prompted the ticket gave 15+ minutes. Start-to-start
 * spacing cannot substitute: it includes the next process's ~20s startup and, when a human is editing
 * files, minutes of idle time — MEASURED at 135s between two reloads here, with no outage at all.
 *
 * ── Constraints this file lives under ──
 *
 * - **Synchronous writes only.** `process.on("exit")` and the tail of a signal handler cannot await
 *   anything; an async append there is silently lost, which would reproduce the very failure this
 *   module exists to fix.
 * - **Never throw.** A record that cannot be written must not be able to take the server down or
 *   change an exit code.
 * - **Append-only JSONL, trimmed at startup.** Trimming at exit would spend IO in the one place that
 *   must stay fast; startup can afford one read.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { DATA_DIR } from "../db/data-dir.js";

/** Filename of the exit log, inside the board's data dir. */
export const EXIT_LOG_FILENAME = "process-exit-log.jsonl";

/**
 * How many lines are kept. Two lines per process life and a `tsx watch` day of ~100 reloads means
 * this holds roughly a week of history — long enough to find yesterday's unexplained gap.
 */
export const EXIT_LOG_MAX_LINES = 1000;

export type ExitRecordKind =
  | "start"
  | "signal"
  | "exit"
  | "uncaught-exception"
  | "unhandled-rejection";

export interface ExitRecord {
  at: string;
  kind: ExitRecordKind;
  pid: number;
  /** Process uptime in ms at the moment of the record. */
  uptimeMs: number;
  /** The signal that arrived (`SIGTERM`/`SIGINT`), when the record was caused by one. */
  signal?: string;
  /** The exit code, when one is known at record time. */
  code?: number | null;
  /** Error message + a short stack head, for the two error kinds. */
  detail?: string;
  /** Process and machine memory at record time — the OOM candidate stands or falls on these. */
  memory: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    externalBytes: number;
    osFreeBytes: number;
    osTotalBytes: number;
  };
}

/** Resolve the log path. `KANBAN_EXIT_LOG_FILE` overrides, so a test never touches the real one. */
export function exitLogPath(): string {
  const override = process.env.KANBAN_EXIT_LOG_FILE;
  if (override && override.trim()) return override.trim();
  return join(DATA_DIR, EXIT_LOG_FILENAME);
}

/** Single-line liveness file: the last moment this process is known to have been running. */
export const HEARTBEAT_FILENAME = "process-alive.json";

/**
 * How often liveness is stamped. The outage figure is only accurate to this interval, and 30s is fine
 * against the 15+ minute outage that prompted the ticket while costing one small overwrite per
 * half-minute.
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Below this, a gap is a restart rather than an outage, and nothing is reported.
 *
 * MEASURED basis: this server's own startup takes ~20s before handlers install, so anything under a
 * minute cannot be distinguished from a reload and must not be announced as a death.
 */
export const OUTAGE_REPORT_THRESHOLD_MS = 60_000;

export interface Heartbeat {
  at: string;
  pid: number;
  uptimeMs: number;
}

export function heartbeatPath(): string {
  const override = process.env.KANBAN_HEARTBEAT_FILE;
  if (override && override.trim()) return override.trim();
  return join(DATA_DIR, HEARTBEAT_FILENAME);
}

/** Stamp liveness. Overwrites, so the file stays one line forever. Never throws. */
export function writeHeartbeat(path: string = heartbeatPath()): void {
  const beat: Heartbeat = {
    at: new Date().toISOString(),
    pid: process.pid,
    uptimeMs: Math.round(process.uptime() * 1000),
  };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(beat)}\n`, "utf8");
  } catch {
    // Best effort by design.
  }
}

/** Read the previous process's last known liveness, or null when absent/unusable. */
export function readHeartbeat(path: string = heartbeatPath()): Heartbeat | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Heartbeat>;
    if (typeof raw.at !== "string" || Number.isNaN(Date.parse(raw.at))) return null;
    return { at: raw.at, pid: typeof raw.pid === "number" ? raw.pid : -1, uptimeMs: typeof raw.uptimeMs === "number" ? raw.uptimeMs : -1 };
  } catch {
    return null;
  }
}

/**
 * How long the board was DOWN before this process started, from the previous process's last
 * heartbeat. Null when there is no usable heartbeat, or when it belongs to THIS process (a re-entrant
 * call), or when the stamp is in the future (clock skew — not evidence of anything).
 */
export function outageBeforeStartMs(
  beat: Heartbeat | null,
  nowMs: number = Date.now(),
  currentPid: number = process.pid,
): number | null {
  if (!beat || beat.pid === currentPid) return null;
  const gap = nowMs - Date.parse(beat.at);
  return gap >= 0 ? gap : null;
}

/**
 * Install the liveness timer. `unref`'d so it can never hold the process open, and it stamps once
 * immediately so a process that dies inside its first interval still leaves a lower bound on when it
 * was last alive. Returns the timer for teardown in tests.
 */
export function startHeartbeat(intervalMs: number = HEARTBEAT_INTERVAL_MS, path: string = heartbeatPath()): NodeJS.Timeout {
  writeHeartbeat(path);
  const timer = setInterval(() => writeHeartbeat(path), intervalMs);
  timer.unref();
  return timer;
}

function memorySnapshot(): ExitRecord["memory"] {
  try {
    const m = process.memoryUsage();
    return {
      rssBytes: m.rss,
      heapUsedBytes: m.heapUsed,
      heapTotalBytes: m.heapTotal,
      externalBytes: m.external,
      osFreeBytes: freemem(),
      osTotalBytes: totalmem(),
    };
  } catch {
    return { rssBytes: 0, heapUsedBytes: 0, heapTotalBytes: 0, externalBytes: 0, osFreeBytes: 0, osTotalBytes: 0 };
  }
}

/**
 * Append one record. Synchronous and never-throwing by contract — see the header.
 *
 * Returns whether the line was written, so a test can assert the failure path is silent rather than
 * inferring it.
 */
export function appendExitRecord(
  input: Omit<ExitRecord, "at" | "pid" | "uptimeMs" | "memory"> & Partial<Pick<ExitRecord, "at" | "pid" | "uptimeMs" | "memory">>,
  path: string = exitLogPath(),
): boolean {
  const record: ExitRecord = {
    at: input.at ?? new Date().toISOString(),
    kind: input.kind,
    pid: input.pid ?? process.pid,
    uptimeMs: input.uptimeMs ?? Math.round(process.uptime() * 1000),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(input.code !== undefined ? { code: input.code } : {}),
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
    memory: input.memory ?? memorySnapshot(),
  };
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Read the log back, newest last. Malformed lines are skipped rather than thrown on. */
export function readExitRecords(path: string = exitLogPath()): ExitRecord[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: ExitRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as ExitRecord;
      if (parsed && typeof parsed.kind === "string" && typeof parsed.at === "string") out.push(parsed);
    } catch {
      // A torn last line (a write interrupted by the very death we are recording) is expected.
    }
  }
  return out;
}

/**
 * Starts that were never followed by an exit record — i.e. processes killed WITHOUT notice.
 *
 * This is the query the ticket needed and could not run: an OOM kill, a `taskkill /F` and a power
 * loss all leave a start with no exit, and nothing else does. The CURRENT process's own start is
 * excluded (by pid) because it has obviously not exited yet.
 */
export function findUnexplainedExits(records: ExitRecord[], currentPid: number = process.pid): ExitRecord[] {
  const unexplained: ExitRecord[] = [];
  let openStart: ExitRecord | null = null;
  for (const record of records) {
    if (record.kind === "start") {
      if (openStart) unexplained.push(openStart);
      openStart = record;
      continue;
    }
    // Any non-start record explains the start it belongs to.
    if (openStart && openStart.pid === record.pid) openStart = null;
  }
  if (openStart && openStart.pid !== currentPid) unexplained.push(openStart);
  return unexplained;
}

/** Keep the log bounded. Called at startup only — never on the exit path. */
export function trimExitLog(path: string = exitLogPath(), maxLines: number = EXIT_LOG_MAX_LINES): void {
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);
    if (lines.length <= maxLines) return;
    writeFileSync(path, `${lines.slice(-maxLines).join("\n")}\n`, "utf8");
  } catch {
    // No log yet, or an unreadable one. Nothing to trim.
  }
}

/**
 * Write this process's START record, trim the log, start the heartbeat, and report a preceding OUTAGE
 * — "the board stopped and nothing noticed", said out loud at the next boot.
 *
 * Reports on the OUTAGE, not on the missing exit record. On this platform the watch wrapper kills the
 * child, so a missing exit record is the NORM and announcing it every time would be pure noise
 * (MEASURED: five consecutive starts, zero exit records, all ordinary reloads). The gap since the
 * previous process last stamped liveness is what separates a reload from the 15+ minute outage the
 * ticket is about.
 */
export function recordProcessStart(
  path: string = exitLogPath(),
  beatPath: string = heartbeatPath(),
): { unexplained: ExitRecord[]; outageMs: number | null } {
  trimExitLog(path);
  const unexplained = findUnexplainedExits(readExitRecords(path));
  const outageMs = outageBeforeStartMs(readHeartbeat(beatPath));
  appendExitRecord({ kind: "start" }, path);
  startHeartbeat(HEARTBEAT_INTERVAL_MS, beatPath);

  if (outageMs !== null && outageMs >= OUTAGE_REPORT_THRESHOLD_MS) {
    const last = unexplained[unexplained.length - 1];
    console.warn(
      `[exit-record] the board was DOWN for ${Math.round(outageMs / 1000)}s before this process started `
      + `— nothing stamped liveness in that window. ${
        last
          ? `The previous server (pid ${last.pid}) left NO exit record, so it was killed without notice; `
            + "OOM, hard kill and power loss are the candidates that cannot write one. Memory at ITS "
            + `start (not at death): rss ${Math.round(last.memory.rssBytes / 1e6)}MB, os free `
            + `${Math.round(last.memory.osFreeBytes / 1e6)}MB.`
          : "The previous server did record its exit — read the log for the signal or code."
      } Log: ${path}. #373`,
    );
  }
  return { unexplained, outageMs };
}
