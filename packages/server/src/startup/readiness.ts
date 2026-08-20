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

/** Reset the gate — tests only; production has exactly one startup per process. */
export function resetStartupReadiness(): void {
  ready = false;
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

export function createStartupReadinessGate(
  opts: { timeoutMs?: number; waitFor?: () => Promise<void>; isComplete?: () => boolean } = {},
): MiddlewareHandler {
  const timeoutMs = opts.timeoutMs ?? READINESS_GATE_TIMEOUT_MS;
  const waitFor = opts.waitFor ?? whenStartupComplete;
  const isComplete = opts.isComplete ?? isStartupComplete;

  return async (c, next) => {
    if (isComplete() || READ_ONLY_METHODS.has(c.req.method)) return next();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      waitFor().then(() => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), timeoutMs); }),
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut) {
      console.warn(
        `[startup] readiness gate timed out after ${timeoutMs}ms for ${c.req.method} ${c.req.path} — proceeding with startup still in flight`,
      );
    }
    return next();
  };
}
