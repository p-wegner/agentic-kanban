/**
 * When does a session's OWN usage-limit event stop mattering? (#1452)
 *
 * A cooldown must come from the limit event the session reported — the reset time it carried, or
 * its end time plus the window — never from "now". Replaying the exit of an old rate-limited
 * session (the #1439 stalled sweep, a restart reattach) used to stamp a fresh 5 h cooldown each
 * time. Pure: no db, no clock.
 */

/** The Claude/Codex usage-limit window, used when the session carried no reset time. */
export const USAGE_LIMIT_WINDOW_MS = 5 * 60 * 60 * 1000;

function parseResetMs(retryAfter: string | null | undefined): number | null {
  const raw = retryAfter?.trim();
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    return n > 1e12 ? n : n * 1000; // epoch seconds (Claude rate_limit_event) or millis
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * ISO instant until which the session's limit still holds, or null when it has already lapsed
 * (so no cooldown is owed). `endedAt` anchors the fallback window; an unparseable one falls back
 * to `nowMs`, i.e. the live-exit behaviour.
 */
export function usageLimitHoldsUntil(input: {
  retryAfter: string | null | undefined;
  endedAt: string | null | undefined;
  nowMs: number;
}): string | null {
  const endedMs = input.endedAt ? Date.parse(input.endedAt) : Number.NaN;
  const anchorMs = Number.isFinite(endedMs) ? endedMs : input.nowMs;
  const resetMs = parseResetMs(input.retryAfter);
  const untilMs = resetMs !== null && resetMs > anchorMs ? resetMs : anchorMs + USAGE_LIMIT_WINDOW_MS;
  return untilMs > input.nowMs ? new Date(untilMs).toISOString() : null;
}
