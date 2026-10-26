// #1724: a lock file the promote holds from build to restart, so the running board's
// worker-build (which packs the stable checkout's dist/) never races the deploy.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** A lock older than this is a dead promote's leftover and is ignored. */
export const PROMOTE_LOCK_STALE_MS = 45 * 60 * 1000;

export function promoteLockPath(checkout) {
  return join(checkout, ".kanban", "promote.lock");
}

export function acquirePromoteLock(checkout, { nowMs = Date.now() } = {}) {
  const file = promoteLockPath(checkout);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ pid: process.pid, atMs: nowMs }));
}

export function releasePromoteLock(checkout) {
  try {
    rmSync(promoteLockPath(checkout), { force: true });
  } catch {
    /* best effort */
  }
}

export function isPromoteLockHeld(checkout, { nowMs = Date.now() } = {}) {
  const file = promoteLockPath(checkout);
  if (!existsSync(file)) return false;
  try {
    const { atMs } = JSON.parse(readFileSync(file, "utf8"));
    return typeof atMs === "number" ? nowMs - atMs < PROMOTE_LOCK_STALE_MS : true;
  } catch {
    return true;
  }
}
