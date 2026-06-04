import type { MiddlewareHandler } from "hono";

const DEFAULT_THRESHOLD_MS = 200;

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
  }
};
