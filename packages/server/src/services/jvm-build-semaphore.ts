/**
 * Concurrency SEMAPHORE for heavyweight, backend-spawned build/verify/smoke invocations (#823).
 *
 * Named a semaphore, not a gate (#611). "Gate" elsewhere in this codebase means a
 * decision-plus-evidence check that can REFUSE — the pre-merge gate, the god-module gate,
 * the verify gate. This refuses nothing: it admits every task, just not all at once. Calling
 * both things a gate made the vocabulary useless at exactly the place it mattered, since
 * this module sits inside pre-merge-gate.service.ts.
 *
 * The board runs the verify_script (e.g. `gradlew test && build`), the boot/render smoke check
 * (`gradlew run`), and the cold-clone build check itself — IN the server process, on review exit.
 * With several reviews finishing together on a JVM stack, these spawn many gradle daemons at once;
 * combined with the builders' own gradle, the box hit ~17 JVMs and CPU-starved the board's own
 * Node backend into repeated wedges and two full crashes. WIP caps the *builders*, but nothing
 * capped the *backend-spawned* gradle — this does.
 *
 * A simple FIFO semaphore. Default width is DERIVED from live capacity (#909, via
 * `deriveVerifyWorkers` in `machine-capacity.ts`) rather than a fixed constant — a box with 14
 * idle cores and a box swapping under five agent worktrees do not deserve the same number.
 * `KANBAN_VERIFY_CONCURRENCY` remains a hard override: set it and the derivation is never
 * consulted, same escape hatch as before. The smoke check additionally serializes itself (one
 * dev server up at a time) because it binds a fixed port; this gate bounds the broader build
 * load around it.
 */
import * as os from "node:os";
import { readTier0Capacity, deriveVerifyWorkers } from "@agentic-kanban/shared/lib/machine-capacity";

let active = 0;
const waiters: Array<() => void> = [];

/** Ceiling on the derived semaphore width, absent an explicit env override — generous because
 *  this bounds backend-spawned BUILD invocations (gradle/verify chains), not vitest forks. */
const DEFAULT_CONCURRENCY_CEILING = 8;

/**
 * Max concurrent backend build/verify invocations. `KANBAN_VERIFY_CONCURRENCY` overrides
 * outright; absent that, derived from live capacity (spare cores / free RAM), clamped to
 * {@link DEFAULT_CONCURRENCY_CEILING}. Never throws — a capacity read failure degrades to the
 * pre-#909 default of 2 rather than blocking a caller that only wanted a concurrency number.
 */
export function buildSemaphoreConcurrency(): number {
  const raw = Number.parseInt(process.env.KANBAN_VERIFY_CONCURRENCY ?? "", 10);
  if (Number.isFinite(raw) && raw >= 1) return raw;
  try {
    const tier0 = readTier0Capacity();
    return deriveVerifyWorkers({ cpuCount: os.cpus().length, freeGb: tier0.freeGb, ceiling: DEFAULT_CONCURRENCY_CEILING });
  } catch {
    return 2;
  }
}

/** Current number of in-flight gated tasks (for diagnostics/tests). */
export function buildSemaphoreActive(): number {
  return active;
}

/**
 * Is a heavyweight verify/build/smoke task running right now (#581)?
 *
 * The monitor asks this before starting a builder: a gate at 6 workers plus a builder's own
 * toolchain saturates the box, and a saturated box manufactures assertion failures in the
 * slow real-git suites that pass everywhere else. Deliberately process-global, because the
 * resource being protected is the machine, not a project.
 */
export function buildGateBusy(): boolean {
  return active > 0;
}

/**
 * Run `task` under the build-concurrency gate: at most `buildSemaphoreConcurrency()` run at once; the
 * rest queue FIFO. Never rejects from the gate itself — a task's own rejection propagates to its
 * caller, and the slot is always released (finally), so one failing/hanging task can't wedge the
 * queue's accounting.
 */
export async function runUnderBuildSemaphore<T>(task: () => Promise<T>): Promise<T> {
  if (active >= buildSemaphoreConcurrency()) {
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
