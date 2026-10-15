// #1499: serialize builder setups (`pnpm install -r`) per worker. Three installs in parallel on a
// saturated disk each ran past the 300 s limit; one alone fits (median 63 s). Agents still run up
// to maxConcurrency once set up - only the setup step queues here.

const DEFAULT_SETUP_SLOTS = 1;

export function resolveSetupSlots(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.WORKER_SETUP_CONCURRENCY);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_SETUP_SLOTS;
}

export interface SetupSlots {
  run<T>(task: (waitedMs: number) => Promise<T>, nowMs?: number): Promise<T>;
  readonly queued: number;
}

export function createSetupSlots(limit: number = resolveSetupSlots()): SetupSlots {
  let active = 0;
  const waiters: Array<() => void> = [];
  return {
    get queued() { return waiters.length; },
    async run(task, nowMs) {
      const start = nowMs ?? Date.now();
      if (active >= limit) await new Promise<void>((resolve) => waiters.push(resolve));
      else active++;
      try {
        return await task(Date.now() - start);
      } finally {
        const next = waiters.shift();
        if (next) next(); // hand the slot over without releasing it
        else active--;
      }
    },
  };
}

/** The worker-wide limiter. */
export const setupSlots = createSetupSlots();
