import type { MiddlewareHandler } from "hono";

/**
 * Startup readiness (#282).
 *
 * The board used to bind its port only after every startup reconciler had finished —
 * measured 238 s of "connection refused" on this checkout, paid again on every `tsx watch`
 * restart. The listener now comes up first and the deferred reconcilers run behind it,
 * which raises one real question: a mutating request can arrive while the state those
 * reconcilers repair is still stale (an unaborted rebase, a silently-merged workspace not
 * yet closed, an orphan service stack not yet reclaimed).
 *
 * So readiness is a GATE, not a race: read-only traffic — the board payload, which is what
 * the freeze was actually about — is served immediately, while mutating requests await
 * this promise first. That preserves the ordering guarantee the old sequence had
 * (`reapOrphanServiceStacksOnce` before any HTTP create could race it) without making
 * every reader wait for it.
 */

let ready = false;
let resolveReady: (() => void) | null = null;
let readyPromise: Promise<void> = new Promise<void>((resolve) => { resolveReady = resolve; });

/** True once the deferred startup phase has finished (or failed — it never blocks forever). */
export function isStartupComplete(): boolean {
  return ready;
}

/** Resolve the gate. Idempotent; safe to call from a `finally`. */
export function markStartupComplete(): void {
  if (ready) return;
  ready = true;
  resolveReady?.();
  resolveReady = null;
}

/** A promise that resolves when the deferred startup phase is done. */
export function whenStartupComplete(): Promise<void> {
  return ready ? Promise.resolve() : readyPromise;
}

let currentPhase = "starting";

/** Name the deferred startup phase now running; the 503 body quotes it. */
export function setStartupPhase(name: string): void {
  currentPhase = name;
}

export function getStartupPhase(): string {
  return currentPhase;
}

/** Reset the gate — tests only; production has exactly one startup per process. */
export function resetStartupReadiness(): void {
  ready = false;
  currentPhase = "starting";
  readyPromise = new Promise<void>((resolve) => { resolveReady = resolve; });
}

/**
 * Requests that only READ are never held: the whole point of #282 is that the board
 * renders immediately. Everything else waits for the deferred phase.
 */
const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Upper bound on how long a mutating request may be held. If the deferred phase somehow
 * hangs (a git call that never returns — the exact failure mode #254 was about), a stuck
 * reconciler must not turn into a permanently unwritable board. Proceeding after the
 * timeout restores the pre-#282 behaviour of "run it anyway", which is strictly no worse.
 */
export const READINESS_GATE_TIMEOUT_MS = 120_000;

/**
 * How long a write is held before it is refused with `503` + `Retry-After` (#1611). Holding it
 * for the full {@link READINESS_GATE_TIMEOUT_MS} looked like a dead board to a client with a
 * normal timeout (curl reported HTTP 000). A short grace still lets a request that arrives a
 * moment before completion through; anything longer fails fast and names the phase running.
 */
export const READINESS_GATE_GRACE_MS = 3_000;
export const READINESS_RETRY_AFTER_SEC = 5;

/**
 * Mutating routes that never race the deferred startup reconcilers (#1473). Preference
 * writes touch only the `preferences` table (+ objective.md); the reconcilers repair
 * git/workspace/service-stack state. Holding them cost every `PUT /api/preferences/settings`
 * the full 120 s timeout after a restart while the sweeps ran (reads answered at once), and a
 * client with a 60 s timeout wrongly concluded the setting had not changed.
 */
const UNGATED_WRITE_PREFIXES = ["/api/preferences/"];

function isUngatedWrite(path: string): boolean {
  return UNGATED_WRITE_PREFIXES.some((p) => path.startsWith(p));
}

export function createStartupReadinessGate(
  opts: {
    timeoutMs?: number;
    graceMs?: number;
    waitFor?: () => Promise<void>;
    isComplete?: () => boolean;
    clock?: () => number;
  } = {},
): MiddlewareHandler {
  const timeoutMs = opts.timeoutMs ?? READINESS_GATE_TIMEOUT_MS;
  const graceMs = Math.min(opts.graceMs ?? READINESS_GATE_GRACE_MS, timeoutMs);
  const waitFor = opts.waitFor ?? whenStartupComplete;
  const isComplete = opts.isComplete ?? isStartupComplete;
  const clock = opts.clock ?? Date.now;
  const createdAt = clock();

  return async (c, next) => {
    if (isComplete() || READ_ONLY_METHODS.has(c.req.method) || isUngatedWrite(c.req.path)) return next();

    // Past the overall bound a hung reconciler must not leave the board permanently
    // unwritable: run the write anyway (the pre-#282 behaviour).
    if (clock() - createdAt >= timeoutMs) {
      console.warn(
        `[startup] readiness gate gave up after ${timeoutMs}ms for ${c.req.method} ${c.req.path} — readiness gate timed out, proceeding with startup still in flight`,
      );
      return next();
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      waitFor().then(() => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), graceMs); }),
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut) {
      const phase = getStartupPhase();
      c.header("Retry-After", String(READINESS_RETRY_AFTER_SEC));
      return c.json(
        {
          error: `Board is still starting up (phase: ${phase}); retry shortly`,
          code: "STARTUP_NOT_READY",
          phase,
          retryAfterSec: READINESS_RETRY_AFTER_SEC,
        },
        503,
      );
    }
    return next();
  };
}
