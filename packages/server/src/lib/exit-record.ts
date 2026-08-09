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
 * Write this process's START record, trim the log, and report any previous death that left no
 * record — the "the board stopped and nothing noticed" case, said out loud at the next boot.
 */
export function recordProcessStart(path: string = exitLogPath()): ExitRecord[] {
  trimExitLog(path);
  const unexplained = findUnexplainedExits(readExitRecords(path));
  appendExitRecord({ kind: "start" }, path);
  for (const start of unexplained) {
    console.warn(
      `[exit-record] a previous server (pid ${start.pid}, started ${start.at}) left NO exit record — `
      + "it was killed without notice (OOM / hard kill / power loss are the candidates that cannot "
      + `write one). Memory at ITS start (not at death): rss ${Math.round(start.memory.rssBytes / 1e6)}MB, `
      + `os free ${Math.round(start.memory.osFreeBytes / 1e6)}MB. #373`,
    );
  }
  return unexplained;
}
