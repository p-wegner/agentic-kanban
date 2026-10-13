// Deferred deletion of worker checkouts that could not be removed (#1445).
//
// On Windows a running process can hold a file inside a checkout (observed: the
// `@rolldown/binding-win32-x64-msvc` `.node` binary in node_modules), so removing the
// checkout fails half way and leaves a stub directory nobody revisits. A removal that
// still fails after its retries records the directory here; the next daemon start and an
// idle sweep retry it until it is gone.
//
// The removal follows the board's `scripts/safe-rmdir.mjs` approach: walk the tree first
// and REFUSE when a reparse point (junction/symlink) points OUTSIDE it, because a purge
// that followed such a link would destroy a live checkout. A refused directory is dropped
// from the list (retrying cannot change the verdict) and logged for a human.
//
// Isolation note: reached from the worker CLI entry, so node builtins only
// (`worker-cli-isolation.test.ts`).

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { execSucceeded } from "@agentic-kanban/shared/lib/exec-result";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export interface PendingDeleteRecord {
  dir: string;
  recordedAt: string;
  attempts: number;
  lastError: string;
}

export function pendingDeleteFile(workRoot: string): string {
  return join(workRoot, "pending-deletes.json");
}

/** Load the pending list. A missing or corrupt file is an empty list, never a throw. */
export function loadPendingDeletes(workRoot: string): PendingDeleteRecord[] {
  try {
    const file = pendingDeleteFile(workRoot);
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { pending?: unknown };
    if (!Array.isArray(parsed.pending)) return [];
    return parsed.pending
      .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null && typeof (r as { dir?: unknown }).dir === "string")
      .map((r) => ({
        dir: r.dir as string,
        recordedAt: typeof r.recordedAt === "string" ? r.recordedAt : "",
        attempts: typeof r.attempts === "number" && Number.isFinite(r.attempts) ? r.attempts : 0,
        lastError: typeof r.lastError === "string" ? r.lastError : "",
      }));
  } catch {
    return [];
  }
}

function savePending(workRoot: string, pending: PendingDeleteRecord[]): void {
  const file = pendingDeleteFile(workRoot);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ pending }, null, 2));
}

/** Record a directory for a later retry. Never throws; returns whether it was persisted. */
export function recordPendingDelete(workRoot: string, dir: string, lastError: string, nowMs: number = Date.now()): boolean {
  try {
    const abs = resolve(dir);
    const all = loadPendingDeletes(workRoot);
    const prior = all.find((r) => resolve(r.dir) === abs);
    const rest = all.filter((r) => resolve(r.dir) !== abs);
    savePending(workRoot, [
      ...rest,
      { dir: abs, recordedAt: prior?.recordedAt || new Date(nowMs).toISOString(), attempts: (prior?.attempts ?? 0) + 1, lastError: lastError.slice(0, 400) },
    ]);
    return true;
  } catch {
    return false;
  }
}

function norm(p: string): string {
  const s = resolve(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
}

function linkTarget(p: string): string | null {
  try {
    const cleaned = String(readlinkSync(p)).replace(/^\\\\\?\\/, "");
    return isAbsolute(cleaned) ? cleaned : resolve(dirname(p), cleaned);
  } catch {
    try { return realpathSync(p); } catch { return null; }
  }
}

/** Reparse points under `root` whose target lies outside it (never descends into a link). */
export function findOutboundLinks(root: string): string[] {
  const out: string[] = [];
  const r = norm(root);
  const stack = [resolve(root)];
  while (stack.length) {
    const dir = stack.pop() as string;
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = join(dir, e.name);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) {
        const t = linkTarget(p);
        const c = t ? norm(t) : null;
        if (!c || !(c === r || c.startsWith(r + sep))) out.push(p);
        continue;
      }
      if (st.isDirectory()) stack.push(p);
    }
  }
  return out;
}

/** Extended-length form so a path past MAX_PATH can still be deleted on Windows. */
function longPath(p: string): string {
  const abs = resolve(p);
  if (process.platform !== "win32" || abs.startsWith("\\\\?\\")) return abs;
  return abs.startsWith("\\\\") ? `\\\\?\\UNC\\${abs.slice(2)}` : `\\\\?\\${abs}`;
}

export type RemoveOutcome = { ok: true } | { ok: false; refused: boolean; error: string };

/**
 * Remove a directory tree with retries for transient locks. Async so a whole node_modules
 * does not block the daemon's event loop (#1420). Refuses on an outbound link.
 */
export async function removeDirWithRetries(dir: string, opts: { retries?: number; retryDelayMs?: number } = {}): Promise<RemoveOutcome> {
  if (!existsSync(dir)) return { ok: true };
  const outbound = findOutboundLinks(dir);
  if (outbound.length > 0) {
    return { ok: false, refused: true, error: `${outbound.length} reparse point(s) point outside the tree, e.g. ${outbound[0]}` };
  }
  try {
    await rm(longPath(dir), { recursive: true, force: true, maxRetries: opts.retries ?? 4, retryDelay: opts.retryDelayMs ?? 500 });
  } catch (err) {
    return { ok: false, refused: false, error: err instanceof Error ? err.message : String(err) };
  }
  return existsSync(dir) ? { ok: false, refused: false, error: "directory still present after removal" } : { ok: true };
}

/** Remove `dir`, or park it in the pending list when a lock defeats the retries. Never throws. */
export async function removeCheckoutDir(
  workRoot: string,
  dir: string,
  log: (line: string) => void,
  opts: { retries?: number; retryDelayMs?: number } = {},
): Promise<boolean> {
  const res = await removeDirWithRetries(dir, opts);
  if (res.ok) return true;
  if (res.refused) {
    log(`[worker] REFUSED to delete ${dir}: ${res.error} - remove the links by hand`);
    return false;
  }
  recordPendingDelete(workRoot, dir, res.error);
  log(`[worker] could not fully remove ${dir} (${res.error}) - queued for deletion on the next sweep`);
  return false;
}

export interface PendingSweepReport {
  checked: number;
  deleted: string[];
  remaining: string[];
  refused: string[];
}

/** Retry every pending directory. Called at daemon start and from the idle sweep. Never throws. */
export async function sweepPendingDeletes(
  workRoot: string,
  log: (line: string) => void = () => {},
  opts: { retries?: number; retryDelayMs?: number } = {},
): Promise<PendingSweepReport> {
  const report: PendingSweepReport = { checked: 0, deleted: [], remaining: [], refused: [] };
  let all: PendingDeleteRecord[];
  try { all = loadPendingDeletes(workRoot); } catch { return report; }
  const keep: PendingDeleteRecord[] = [];
  for (const rec of all) {
    report.checked++;
    const res = await removeDirWithRetries(rec.dir, opts);
    if (res.ok) {
      report.deleted.push(rec.dir);
      log(`[worker] pending delete completed: ${rec.dir}`);
    } else if (res.refused) {
      report.refused.push(rec.dir);
      log(`[worker] REFUSED pending delete of ${rec.dir}: ${res.error} - dropped from the list`);
    } else {
      report.remaining.push(rec.dir);
      keep.push({ ...rec, attempts: rec.attempts + 1, lastError: res.error.slice(0, 400) });
    }
  }
  if (report.checked > 0) {
    try { savePending(workRoot, keep); } catch { /* retried next sweep */ }
  }
  return report;
}

/**
 * #1445: on Windows a deep node_modules path overruns MAX_PATH and `git worktree remove` fails
 * with "Filename too long". `core.longpaths` lives in the cache repo's config, which every
 * worktree shares. Best-effort; no-op elsewhere.
 */
export async function ensureLongPaths(cacheDir: string, log: (line: string) => void = () => {}): Promise<void> {
  if (process.platform !== "win32") return;
  try {
    const res = await gitExec(["config", "--local", "core.longpaths", "true"], { cwd: cacheDir });
    if (!execSucceeded(res)) log(`[worker] could not set core.longpaths in ${cacheDir} (non-fatal)`);
  } catch (err) {
    log(`[worker] could not set core.longpaths in ${cacheDir}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Throttled idle sweep for the daemon's existing tick: runs at most once per `everyMs`. */
export function createPendingDeleteSweeper(workRoot: string, log: (line: string) => void, everyMs: number = 5 * 60 * 1000): () => void {
  let last = 0;
  let running = false;
  return () => {
    const now = Date.now();
    if (running || now - last < everyMs) return;
    last = now;
    running = true;
    void sweepPendingDeletes(workRoot, log).catch(() => {}).finally(() => { running = false; });
  };
}
