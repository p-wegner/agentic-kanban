// On-disk record of completed-but-undelivered session results (#871).
//
// A finished result whose push failed used to be tracked in MEMORY ONLY (#750), which
// was fine right up until the daemon died — and the observed failure mode is exactly
// that: the supervisor restarts the daemon 2 s later and the fresh process has no idea
// the previous one was still holding a pushed-nowhere run. The checkout survives on
// disk (retainUnpushed keeps it), so the WORK survives; what did not survive was the
// knowledge that it exists.
//
// This module is that knowledge: a small JSON file under the worker's work root, one
// entry per undelivered session. DELIBERATELY WITHOUT the git token — the token is
// per-assignment and writing a credential to the worker's disk is exactly what
// `worker-repo.ts` goes out of its way to avoid. A restored entry therefore retries
// its push with no credential (which fails against a token-authed transport) and is
// then REPORTED to the board over the control socket instead, so an operator can land
// the work deliberately. An entry restored while its original token was still in
// memory never exists: the in-memory entry wins and carries the real token.
//
// Isolation note: this file is reached from the worker CLI entry, so it may import
// nothing beyond node builtins and the shared protocol types
// (`worker-cli-isolation.test.ts` enforces it).

import { workerLog } from "./worker-updater.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** One completed session this worker still owes the board. No token — see the header. */
export interface UndeliveredSessionRecord {
  sessionId: string;
  /** The board-side feature branch the run was for. */
  branch: string;
  /** Start point fallback carried so a restored transport shape is complete. */
  baseBranch: string;
  /** Where the push was aimed: `refs/kanban/incoming/<branch>`. */
  incomingRef: string;
  /** The kept per-session checkout holding the commits. */
  checkoutPath: string;
  /** The cache clone that also holds `kanban/<sessionId>`. */
  cacheDir: string;
  /** Needed to recompose the git URL for a retry after a restart. */
  projectId: string;
  gitPort: number;
  attempts: number;
  lastError: string;
  recordedAt: string;
}

export function undeliveredStateFile(workRoot: string): string {
  return join(workRoot, "undelivered-results.json");
}

/** An undelivered result whose checkout and branch are gone: no longer retried (#1406). */
export interface LostSessionRecord extends UndeliveredSessionRecord {
  lostAt: string;
  reason: string;
}

interface UndeliveredStateFile {
  results: UndeliveredSessionRecord[];
  lost?: LostSessionRecord[];
}

function isRecord(value: unknown): value is UndeliveredSessionRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.sessionId === "string" &&
    typeof r.branch === "string" &&
    typeof r.incomingRef === "string" &&
    typeof r.checkoutPath === "string" &&
    typeof r.cacheDir === "string" &&
    typeof r.projectId === "string" &&
    typeof r.gitPort === "number"
  );
}

/** Load every persisted record. A missing or corrupt file is an empty list, never a throw. */
export function loadUndelivered(workRoot: string): UndeliveredSessionRecord[] {
  const file = undeliveredStateFile(workRoot);
  try {
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<UndeliveredStateFile>;
    if (!Array.isArray(parsed.results)) return [];
    return parsed.results.filter(isRecord).map((r) => ({
      ...r,
      baseBranch: typeof r.baseBranch === "string" ? r.baseBranch : r.branch,
      attempts: typeof r.attempts === "number" && Number.isFinite(r.attempts) ? r.attempts : 0,
      lastError: typeof r.lastError === "string" ? r.lastError : "",
      recordedAt: typeof r.recordedAt === "string" ? r.recordedAt : "",
    }));
  } catch {
    // Corrupt state loses only the POINTER; the checkouts themselves are still on disk
    // and named in the daemon log. Never let a bad file take the daemon down (#870).
    return [];
  }
}

/** Load the `lost` list (#1406). A missing or corrupt file is an empty list, never a throw. */
export function loadLost(workRoot: string): LostSessionRecord[] {
  try {
    const file = undeliveredStateFile(workRoot);
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<UndeliveredStateFile>;
    if (!Array.isArray(parsed.lost)) return [];
    return parsed.lost.filter(isRecord).map((r) => ({
      ...r,
      baseBranch: typeof r.baseBranch === "string" ? r.baseBranch : r.branch,
      attempts: typeof r.attempts === "number" && Number.isFinite(r.attempts) ? r.attempts : 0,
      lastError: typeof r.lastError === "string" ? r.lastError : "",
      recordedAt: typeof r.recordedAt === "string" ? r.recordedAt : "",
      lostAt: typeof r.lostAt === "string" ? r.lostAt : "",
      reason: typeof r.reason === "string" ? r.reason : "",
    }));
  } catch {
    return [];
  }
}

function save(workRoot: string, results: UndeliveredSessionRecord[], lost: LostSessionRecord[] = loadLost(workRoot)): void {
  const file = undeliveredStateFile(workRoot);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ results, lost } satisfies UndeliveredStateFile, null, 2));
}

/**
 * Move a session from the retry list to the `lost` list (#1406). Never throws. Returns whether
 * the move was persisted; on failure the entry stays in `results` and is judged again next time.
 */
export function markUndeliveredLost(workRoot: string, sessionId: string, reason: string, lostAt: string): boolean {
  try {
    const all = loadUndelivered(workRoot);
    const record = all.find((r) => r.sessionId === sessionId);
    if (!record) return false;
    const lost = loadLost(workRoot).filter((r) => r.sessionId !== sessionId);
    save(
      workRoot,
      all.filter((r) => r.sessionId !== sessionId),
      [...lost, { ...record, lostAt, reason }],
    );
    return true;
  } catch {
    return false;
  }
}

/** Add or replace the record for a session. Never throws — persistence is best-effort. */
export function upsertUndelivered(workRoot: string, record: UndeliveredSessionRecord): boolean {
  try {
    const rest = loadUndelivered(workRoot).filter((r) => r.sessionId !== record.sessionId);
    save(workRoot, [...rest, record]);
    return true;
  } catch (err) {
    workerLog(
      `[worker] could not persist the undelivered-result record for sessionId=${record.sessionId}: ` +
        `${err instanceof Error ? err.message : String(err)} - the checkout is still kept, but a ` +
        `daemon restart will not know about it`,
    );
    return false;
  }
}

/** Give up on an entry after this many failed attempts (#1416). */
export const UNDELIVERED_MAX_ATTEMPTS = 30;
/** ...or once it has been held this long. */
export const UNDELIVERED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Age of a record in ms, or null when `recordedAt` is missing/unparseable. */
export function undeliveredAgeMs(recordedAt: string, nowMs: number = Date.now()): number | null {
  const t = Date.parse(recordedAt);
  return Number.isFinite(t) ? Math.max(0, nowMs - t) : null;
}

/** Why an entry should be dropped instead of retried again, or null to keep retrying (#1416). */
export function undeliveredGiveUpReason(
  entry: { attempts: number; recordedAt: string },
  nowMs: number = Date.now(),
): string | null {
  if (entry.attempts >= UNDELIVERED_MAX_ATTEMPTS) {
    return `${entry.attempts} failed attempts (limit ${UNDELIVERED_MAX_ATTEMPTS})`;
  }
  const age = undeliveredAgeMs(entry.recordedAt, nowMs);
  if (age !== null && age >= UNDELIVERED_MAX_AGE_MS) {
    return `held for ${Math.round(age / 3_600_000)}h (limit ${Math.round(UNDELIVERED_MAX_AGE_MS / 3_600_000)}h)`;
  }
  return null;
}

/** Drop a session's record once its result has been delivered. Never throws. */
export function removeUndelivered(workRoot: string, sessionId: string): void {
  try {
    const all = loadUndelivered(workRoot);
    const rest = all.filter((r) => r.sessionId !== sessionId);
    if (rest.length === all.length) return;
    save(workRoot, rest);
  } catch {
    // A stale entry is re-reported on the next reconnect; harmless next to a throw here.
  }
}
