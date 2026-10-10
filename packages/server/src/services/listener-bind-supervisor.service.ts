// Retrying bind for the fleet listener and the eager git transport (#1325).
//
// A board that starts before tailscaled has the tailnet interface up gets EADDRNOTAVAIL on a
// `KANBAN_FLEET_HOST=<tailnet ip>` bind. That used to be logged once and never retried, so the
// board ran its whole lifetime without a fleet. This supervisor retries with capped exponential
// backoff, logs the recovery, and keeps a per-listener state that /api/health and
// `worker doctor-board` read.

export type ListenerStatus = "disabled" | "bound" | "retrying";

export interface ListenerState {
  status: ListenerStatus;
  host: string | null;
  port: number | null;
  /** Last bind error while retrying; null once bound. */
  error: string | null;
  attempts: number;
  nextRetryAt: string | null;
  boundAt: string | null;
}

const states = new Map<string, ListenerState>();

const emptyState = (): ListenerState => ({
  status: "disabled", host: null, port: null, error: null, attempts: 0, nextRetryAt: null, boundAt: null,
});

export function getListenerState(name: string): ListenerState {
  return { ...(states.get(name) ?? emptyState()) };
}

export function resetListenerStates(): void {
  states.clear();
}

export const BIND_RETRY_BASE_MS = 2_000;
export const BIND_RETRY_MAX_MS = 60_000;

/** 2s, 4s, 8s ... capped at 60s. `attempt` is the number of failures so far (>= 1). */
export function bindRetryDelayMs(attempt: number): number {
  return Math.min(BIND_RETRY_MAX_MS, BIND_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

export interface SuperviseBindOptions<H> {
  /** State key and log tag, e.g. "fleet-listener". */
  name: string;
  start: () => Promise<H>;
  /** Where the handle ended up, for the state record. */
  describe: (handle: H) => { host: string; port: number };
  /** Hostname hint recorded while retrying (the configured, possibly unresolved, host). */
  configuredHost?: string | null;
  configuredPort?: number | null;
  /** Return false for a failure retrying cannot fix (misconfiguration). Default: retry everything. */
  isRetryable?: (err: unknown) => boolean;
  /** Injectable timer seam; returns a cancel function. */
  schedule?: (fn: () => void, ms: number) => () => void;
  nowMs?: number;
  onBound?: (handle: H) => void;
}

export interface BindSupervisor {
  stop(): void;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

/** Try the bind now; on failure keep retrying with backoff until it binds or `stop()` is called. */
export async function superviseBind<H>(opts: SuperviseBindOptions<H>): Promise<BindSupervisor> {
  const schedule = opts.schedule ?? defaultSchedule;
  let stopped = false;
  let cancel: (() => void) | null = null;
  let attempts = 0;

  const state: ListenerState = {
    ...emptyState(), host: opts.configuredHost ?? null, port: opts.configuredPort ?? null,
  };
  states.set(opts.name, state);

  const attempt = async (): Promise<void> => {
    cancel = null;
    if (stopped) return;
    try {
      const handle = await opts.start();
      if (stopped) return;
      const where = opts.describe(handle);
      const recovered = attempts > 0;
      Object.assign(state, {
        status: "bound", host: where.host, port: where.port, error: null, nextRetryAt: null,
        boundAt: new Date(opts.nowMs ?? Date.now()).toISOString(),
      } satisfies Partial<ListenerState>);
      if (recovered) console.log(`[${opts.name}] recovered after ${attempts} failed attempt(s): bound ${where.host}:${where.port}`);
      opts.onBound?.(handle);
    } catch (err) {
      if (stopped) return;
      attempts += 1;
      state.attempts = attempts;
      state.error = errMsg(err);
      if (opts.isRetryable && !opts.isRetryable(err)) {
        state.status = "retrying";
        state.nextRetryAt = null;
        console.error(`[${opts.name}] bind failed and is not retryable: ${state.error}`);
        return;
      }
      const delay = bindRetryDelayMs(attempts);
      state.status = "retrying";
      state.nextRetryAt = new Date((opts.nowMs ?? Date.now()) + delay).toISOString();
      console.error(`[${opts.name}] bind failed (attempt ${attempts}); retrying in ${Math.round(delay / 1000)}s: ${state.error}`);
      cancel = schedule(() => { void attempt(); }, delay);
    }
  };

  await attempt();
  return {
    stop() {
      stopped = true;
      cancel?.();
      cancel = null;
    },
  };
}
