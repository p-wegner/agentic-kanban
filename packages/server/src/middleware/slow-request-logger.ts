import type { MiddlewareHandler } from "hono";

const DEFAULT_THRESHOLD_MS = 200;
const RING_BUFFER_SIZE = 100;

export interface SlowRequestEntry {
  method: string;
  path: string;
  durationMs: number;
  timestamp: string;
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
  const raw = process.env.SLOW_REQUEST_THRESHOLD_MS;
  if (raw != null && raw !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_THRESHOLD_MS;
}

export const slowRequestLogger: MiddlewareHandler = async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  const method = c.req.method;
  const path = c.req.path;

  console.debug(`[request] ${method} ${path} ${ms}ms`);

  if (ms > getThreshold()) {
    console.warn(`[slow-request] ${method} ${path} took ${ms}ms`);
    if (slowRequestBuffer.length >= RING_BUFFER_SIZE) {
      slowRequestBuffer.shift();
    }
    slowRequestBuffer.push({ method, path, durationMs: ms, timestamp: new Date().toISOString() });
  }
};
