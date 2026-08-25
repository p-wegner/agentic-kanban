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

interface UndeliveredStateFile {
  results: UndeliveredSessionRecord[];
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

function save(workRoot: string, results: UndeliveredSessionRecord[]): void {
  const file = undeliveredStateFile(workRoot);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ results } satisfies UndeliveredStateFile, null, 2));
}

/** Add or replace the record for a session. Never throws — persistence is best-effort. */
export function upsertUndelivered(workRoot: string, record: UndeliveredSessionRecord): void {
  try {
    const rest = loadUndelivered(workRoot).filter((r) => r.sessionId !== record.sessionId);
    save(workRoot, [...rest, record]);
  } catch (err) {
    console.warn(
      `[worker] could not persist the undelivered-result record for sessionId=${record.sessionId}: ` +
        `${err instanceof Error ? err.message : String(err)} — the checkout is still kept, but a ` +
        `daemon restart will not know about it`,
    );
  }
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
