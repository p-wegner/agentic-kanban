/**
 * Concurrency limiter for heavyweight, backend-spawned build/verify/smoke invocations (#823).
 *
 * The board runs the verify_script (e.g. `gradlew test && build`), the boot/render smoke check
 * (`gradlew run`), and the cold-clone build check itself — IN the server process, on review exit.
 * With several reviews finishing together on a JVM stack, these spawn many gradle daemons at once;
 * combined with the builders' own gradle, the box hit ~17 JVMs and CPU-starved the board's own
 * Node backend into repeated wedges and two full crashes. WIP caps the *builders*, but nothing
 * capped the *backend-spawned* gradle — this does.
 *
 * A simple FIFO semaphore. Default cap is small (2) and overridable via KANBAN_VERIFY_CONCURRENCY;
 * set it from CPU count if you prefer (`max(1, cpus-2)`), but a low fixed default is the safe
 * choice on a shared dev box. The smoke check additionally serializes itself (one dev server up at
 * a time) because it binds a fixed port; this gate bounds the broader build load around it.
 */

let active = 0;
const waiters: Array<() => void> = [];

/** Max concurrent backend build/verify invocations. Env-overridable; clamped to >= 1. */
export function buildGateConcurrency(): number {
  const raw = Number.parseInt(process.env.KANBAN_VERIFY_CONCURRENCY ?? "", 10);
  return Number.isFinite(raw) && raw >= 1 ? raw : 2;
}

/** Current number of in-flight gated tasks (for diagnostics/tests). */
export function buildGateActive(): number {
  return active;
}

/**
 * Run `task` under the build-concurrency gate: at most `buildGateConcurrency()` run at once; the
 * rest queue FIFO. Never rejects from the gate itself — a task's own rejection propagates to its
 * caller, and the slot is always released (finally), so one failing/hanging task can't wedge the
 * queue's accounting.
 */
export async function runUnderBuildGate<T>(task: () => Promise<T>): Promise<T> {
  if (active >= buildGateConcurrency()) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  active++;
  try {
    return await task();
  } finally {
    active--;
    const next = waiters.shift();
    if (next) next();
  }
}
