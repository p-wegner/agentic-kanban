import { readBoardEnv } from "../lib/env-registry.js";
import type { MiddlewareHandler } from "hono";

const DEFAULT_THRESHOLD_MS = 200;
const RING_BUFFER_SIZE = 100;

/**
 * When the worst event-loop stall overlapping a request accounts for at least this
 * fraction of the request's wall time, the log line attributes the duration to loop
 * starvation instead of the handler (#405). Wall time alone CONFLATES "this handler was
 * slow" with "this handler sat behind someone else's block" — /api/health measured
 * 6-42s of wall time while doing microseconds of work, which mis-directed a whole perf
 * review toward the wrong code.
 */
const STARVATION_FRACTION = 0.5;

// ---------------------------------------------------------------------------
// Process-wide lag probe.
//
// Why not perf_hooks.monitorEventLoopDelay per request: its histogram uses the FIRST
// timer fire after enable() to establish a baseline, so a block that starts in the same
// tick as enable() — i.e. any stall already underway or beginning as the request enters
// the middleware — records NOTHING (verified: 300ms sync block right after enable()
// leaves count=0, max=0). And the process-wide histogram in lib/loop-lag-registry.ts
// has its window reset asynchronously by the warn timer and metrics scrapes, so a delta
// against it cannot be attributed to one request's lifetime.
//
// A self-timing setTimeout probe records TIMESTAMPED samples instead: schedule a timer,
// measure how late it fired. A sync block delays the probe, and the delayed callback
// then records the stall's length with the time it ended — which lets each request
// window the ring to exactly the stalls that overlapped it.
// ---------------------------------------------------------------------------

const LAG_PROBE_INTERVAL_MS = 10;
const LAG_RING_SIZE = 1024; // >= ~10s of history at 10ms cadence; a long stall is 1 sample

interface LagProbeSample {
  /** When the delayed probe fired, i.e. when the stall ended. */
  endedAt: number;
  /** How late the probe fired — the length of the stall that delayed it. */
  lagMs: number;
}

const lagRing: LagProbeSample[] = [];
let lagProbeStarted = false;

function ensureLagProbe(): void {
  if (lagProbeStarted) return;
  lagProbeStarted = true;
  const schedule = (): void => {
    const expected = Date.now() + LAG_PROBE_INTERVAL_MS;
    const timer = setTimeout(() => {
      const now = Date.now();
      const lagMs = Math.max(0, now - expected);
      if (lagRing.length >= LAG_RING_SIZE) lagRing.shift();
      lagRing.push({ endedAt: now, lagMs });
      schedule();
    }, LAG_PROBE_INTERVAL_MS);
    timer.unref?.();
  };
  schedule();
}

export interface RequestLagSample {
  /** Worst event-loop stall overlapping the request, clamped to the overlap, in ms. */
  maxMs: number;
  /** Median probe lag over the request's lifetime, in ms. */
  p50Ms: number;
}

export interface RequestLagSampler {
  /** Stop sampling and return what was observed during the request. */
  stop(): RequestLagSample;
}

function startRequestLagSampler(): RequestLagSampler {
  ensureLagProbe();
  const startedAt = Date.now();
  return {
    stop() {
      const lags: number[] = [];
      let maxMs = 0;
      for (const sample of lagRing) {
        if (sample.endedAt < startedAt) continue;
        // A stall that began BEFORE the request only starved it for the part after
        // startedAt — clamp so the attribution can never exceed the request's own span.
        const overlapMs = Math.min(sample.lagMs, sample.endedAt - startedAt);
        if (overlapMs > maxMs) maxMs = overlapMs;
        lags.push(sample.lagMs);
      }
      lags.sort((a, b) => a - b);
      const p50Ms = lags.length > 0 ? lags[Math.floor(lags.length / 2)] : 0;
      return { maxMs, p50Ms };
    },
  };
}

export interface SlowRequestEntry {
  method: string;
  path: string;
  durationMs: number;
  timestamp: string;
  /** Worst event-loop stall overlapping this request (ms). */
  loopLagMaxMs?: number;
  /** Median event-loop lag over this request's lifetime (ms). */
  loopLagP50Ms?: number;
  /** True when lag accounts for the majority of durationMs — starved, not handler. */
  starved?: boolean;
}

// Bounded ring buffer — oldest entry is overwritten when full.
const slowRequestBuffer: SlowRequestEntry[] = [];

export function getSlowRequests(): SlowRequestEntry[] {
  return slowRequestBuffer.slice().reverse();
}

export function clearSlowRequests(): void {
  slowRequestBuffer.length = 0;
}

function getThreshold(): number {
  const raw = readBoardEnv("KANBAN_SLOW_REQUEST_THRESHOLD_MS");
  if (raw != null && raw !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_THRESHOLD_MS;
}

/**
 * @param startSampler Injected for tests; defaults to the real probe-backed sampler.
 */
export function createSlowRequestLogger(options?: {
  startSampler?: () => RequestLagSampler;
}): MiddlewareHandler {
  const startSampler = options?.startSampler ?? startRequestLagSampler;

  return async (c, next) => {
    const start = Date.now();
    const sampler = startSampler();
    await next();
    const ms = Date.now() - start;
    const method = c.req.method;
    const path = c.req.path;

    console.debug(`[request] ${method} ${path} ${ms}ms`);

    if (ms <= getThreshold()) {
      sampler.stop();
      return;
    }

    // A sync block delays the lag probe, and the delayed probe only records its sample
    // in the timers phase. This post-`next` code runs in a microtask BEFORE that phase,
    // so reading the ring here would miss the very stall we are trying to attribute.
    // Yield one macrotask (setImmediate runs in the check phase, AFTER timers) so the
    // sample lands first. Only the slow path pays this one-tick delay.
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    const lag = sampler.stop();
    const starved = lag.maxMs >= STARVATION_FRACTION * ms;

    const lagSuffix = starved
      ? ` (loop lag max ${lag.maxMs}ms p50 ${lag.p50Ms}ms — starved, not handler)`
      : "";
    console.warn(`[slow-request] ${method} ${path} took ${ms}ms${lagSuffix}`);

    if (slowRequestBuffer.length >= RING_BUFFER_SIZE) {
      slowRequestBuffer.shift();
    }
    slowRequestBuffer.push({
      method,
      path,
      durationMs: ms,
      timestamp: new Date().toISOString(),
      loopLagMaxMs: lag.maxMs,
      loopLagP50Ms: lag.p50Ms,
      starved,
    });
  };
}

export const slowRequestLogger: MiddlewareHandler = createSlowRequestLogger();
