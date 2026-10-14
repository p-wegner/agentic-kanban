import { resolve } from "node:path";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { workerLog } from "./worker-updater.js";

const cacheChains = new Map<string, Promise<unknown>>();

/**
 * #1474: serialize clone/fetch against one cached clone. Two assignments for the same project
 * arriving together (maxConcurrency > 1) both ran `git fetch ... --prune` into the same
 * `refs/remotes/origin/*`; the loser died with "cannot lock ref ... but expected ...".
 * Callers for DIFFERENT clones never wait on each other.
 */
export function withCacheLock<T>(cacheDir: string, run: () => Promise<T>): Promise<T> {
  const key = resolve(cacheDir);
  const prev = cacheChains.get(key) ?? Promise.resolve();
  const next = prev.then(run, run);
  const tail = next.catch(() => undefined);
  cacheChains.set(key, tail);
  void tail.then(() => { if (cacheChains.get(key) === tail) cacheChains.delete(key); });
  return next;
}

/** Git's ref-update race signatures (a concurrent writer moved the ref under us). */
export function isRefLockRace(message: string): boolean {
  return /cannot lock ref|unable to update local ref/i.test(message);
}

/** Run a ref-writing git step; retry ONCE when it lost a ref-lock race (#1474). */
export async function retryOnRefLockRace<T>(run: () => Promise<T>, log: (line: string) => void = workerLog): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!isRefLockRace(errorMessage(err))) throw err;
    log(`[worker] git lost a ref-lock race (${errorMessage(err).slice(0, 160)}) - retrying once`);
    return run();
  }
}
