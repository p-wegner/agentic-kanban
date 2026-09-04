/**
 * The throttled OAuth quota READER, shared by the board and its fleet workers (#1027).
 *
 * This is `services/oauth-quota-provider.ts`'s engine, lifted out of the server package
 * without a line of behaviour changed — the TTL that scales with utilization, the
 * one-profile-per-tick round robin, the `Retry-After`-honouring backoff, the
 * last-known-good gauges that survive a 429. All of it was already PORTED (not invented)
 * from `claude-pick/fleet/lib/usage.mjs`, which paid for the traps; a second copy on the
 * worker side would be the third generation of the same logic and the first place two of
 * them could disagree about what "exhausted" means.
 *
 * WHY IT HAD TO MOVE. A worker attests its profiles and reports THEIR quota, measured
 * against its own tokens (#1027 step 2). It cannot import the board's provider: the
 * `agentic-kanban-worker` binary is isolated from `src/services/` and from the shared
 * barrel by `worker-cli-isolation.test.ts`, on purpose — a worker machine has no board,
 * no database and no drizzle. So the engine lives here, in a dependency-free node-only
 * module both sides import by deep path, and the board's provider keeps the part that is
 * genuinely board-shaped: profile discovery through its rings, and the wire DTO.
 *
 * WHAT NEVER TRAVELS. The token is read on the machine that owns it and is used for
 * exactly one request from that machine. What crosses a wire is a PERCENTAGE. That is the
 * whole reason attestation can narrow #651 without touching decision 012.
 *
 * NODE-ONLY (`node:fs`, `node:path`): import by the deep path
 * `../lib/oauth-quota-core.js`, never from the client barrel.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/** Beta header the OAuth usage endpoint requires. */
export const OAUTH_BETA = "oauth-2025-04-20";

export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * One reset window. A measurement older than this is `unknown`: the 5-hour window it
 * describes has certainly reset since, so the number is not merely stale, it is about
 * a window that no longer exists.
 */
export const MEASUREMENT_STALE_MS = FIVE_HOURS_MS;

/** A profile the reader can poll: a name plus the config dir holding its OAuth login. */
export interface OAuthProfileRef {
  profile: string;
  configDir: string;
}

/** Outcome of reading one profile's `.credentials.json`. Never throws. */
export type CredentialRead =
  | { token: string; tier: string | null; err?: undefined }
  | { err: "no-creds" | "bad-creds" | "no-token" | "expired"; tier?: string | null; token?: undefined };

/** One cached measurement for one profile. `dataTs` is the age anchor: when the NUMBERS were true. */
export interface QuotaCacheRecord {
  /** When this record was written (ms). */
  ts: number;
  ok: boolean;
  err: string | null;
  /** When the gauges below were actually measured (ms), or null if never. */
  dataTs: number | null;
  /** Earliest ms at which another request may be made (failure backoff). */
  nextTry: number;
  tier: string | null;
  fiveH: number | null;
  fiveHReset: string | null;
  sevenD: number | null;
  sevenDReset: string | null;
}

export function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Refresh interval by distance to the cap. Ported verbatim from the reference's
 * `daemonTtlSec` — the numbers are measured, not chosen.
 */
export function refreshIntervalMs(rec: QuotaCacheRecord | undefined): number {
  const used = Math.max(numOrNull(rec?.fiveH) ?? 0, numOrNull(rec?.sevenD) ?? 0);
  if (used >= 80) return 2 * 60_000;
  if (used >= 50) return 5 * 60_000;
  return 10 * 60_000;
}

/**
 * Backoff after a failed refresh, in ms. A 429 honours `Retry-After` when the server
 * sent one; everything else gets a fixed, deliberately generous window — the cost of
 * waiting is a slightly older number, the cost of retrying hard is the rate limit.
 */
export function backoffMs(err: string | null, retryAfterSec = 0): number {
  if (err === "http-429") return retryAfterSec > 0 ? retryAfterSec * 1000 : 300_000;
  if (/^http-5\d\d$/.test(err ?? "")) return 120_000;
  if (["expired", "no-token", "no-creds", "bad-creds"].includes(err ?? "")) return 120_000;
  return 60_000;
}

/** `"max 20x"` from `subscriptionType` plus the multiplier embedded in `rateLimitTier`. */
export function tierOf(oauth: Record<string, unknown> | null | undefined): string | null {
  if (!oauth) return null;
  const sub = typeof oauth.subscriptionType === "string" ? oauth.subscriptionType : null;
  const m = /(\d+x)/.exec(typeof oauth.rateLimitTier === "string" ? oauth.rateLimitTier : "");
  if (sub) return m ? `${sub} ${m[1]}` : sub;
  return m ? m[1] : null;
}

/**
 * Read a profile's OAuth token + tier from `<configDir>/.credentials.json` — the same
 * file `claude-subscription-ring.ts` uses to decide a subscription is logged in.
 * Never throws. An EXPIRED token short-circuits: spending a request we know will fail
 * is a guaranteed waste of the rate budget we are protecting.
 */
export function readOAuthCredentials(configDir: string, nowMs = Date.now()): CredentialRead {
  const file = join(configDir, ".credentials.json");
  if (!existsSync(file)) return { err: "no-creds" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch {
    return { err: "bad-creds" };
  }
  const oauth = (parsed as { claudeAiOauth?: Record<string, unknown> } | null)?.claudeAiOauth;
  if (!oauth || typeof oauth.accessToken !== "string" || !oauth.accessToken) return { err: "no-token" };
  const expiresAt = Number(oauth.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt > 0 && nowMs >= expiresAt) {
    return { err: "expired", tier: tierOf(oauth) };
  }
  return { token: oauth.accessToken, tier: tierOf(oauth) };
}

/** Result of one live fetch. Mirrors the reference's `fetchUsage` record shape. */
export interface FetchOutcome {
  ok: boolean;
  err: string | null;
  retryAfterSec: number;
  tier: string | null;
  fiveH: number | null;
  fiveHReset: string | null;
  sevenD: number | null;
  sevenDReset: string | null;
}

export const FAILED = (err: string, tier: string | null = null, retryAfterSec = 0): FetchOutcome => ({
  ok: false, err, retryAfterSec, tier,
  fiveH: null, fiveHReset: null, sevenD: null, sevenDReset: null,
});

function pickNumber(o: unknown, key: string): number | null {
  return numOrNull((o as Record<string, unknown> | null)?.[key]);
}

function pickString(o: unknown, key: string): string | null {
  const v = (o as Record<string, unknown> | null)?.[key];
  return typeof v === "string" && v ? v : null;
}

/** `Retry-After` as seconds, accepting both the delta-seconds and the HTTP-date form. */
export function parseRetryAfter(raw: string | null, nowMs = Date.now()): number {
  if (!raw) return 0;
  const n = Number(raw);
  if (Number.isFinite(n)) return Math.max(0, n);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, Math.round((at - nowMs) / 1000)) : 0;
}

/**
 * Merge a fetch outcome into the cache, PRESERVING the last-known-good gauges on
 * failure. Blanking a display on a transient 429 is strictly worse than showing a
 * slightly older number with its age attached — and a 429 must never read as an
 * exhausted profile, which is what dropping to "no data" would look like downstream.
 */
export function mergeRecord(
  prev: QuotaCacheRecord | undefined,
  fetched: FetchOutcome,
  nowMs: number,
): QuotaCacheRecord {
  if (fetched.ok) {
    return {
      ts: nowMs, ok: true, err: null, dataTs: nowMs, nextTry: 0, tier: fetched.tier,
      fiveH: fetched.fiveH, fiveHReset: fetched.fiveHReset,
      sevenD: fetched.sevenD, sevenDReset: fetched.sevenDReset,
    };
  }
  const hadData = prev != null && (prev.fiveH != null || prev.sevenD != null);
  return {
    ts: nowMs,
    ok: false,
    err: fetched.err,
    dataTs: hadData ? prev!.dataTs : null,
    nextTry: nowMs + backoffMs(fetched.err, fetched.retryAfterSec),
    tier: fetched.tier ?? prev?.tier ?? null,
    fiveH: hadData ? prev!.fiveH : null,
    fiveHReset: hadData ? prev!.fiveHReset : null,
    sevenD: hadData ? prev!.sevenD : null,
    sevenDReset: hadData ? prev!.sevenDReset : null,
  };
}

export interface OAuthQuotaPollerOptions {
  /** Injected for tests. Defaults to the global `fetch`; a test MUST pass a fake. */
  fetchImpl?: typeof fetch;
  /** Injected for tests. Defaults to reading `<configDir>/.credentials.json`. */
  readCredentials?: (configDir: string, nowMs: number) => CredentialRead;
  /** Every outbound request is logged through here. */
  log?: (line: string) => void;
  timeoutMs?: number;
}

/**
 * The engine: a cache of per-profile measurements plus the ONE-REQUEST-PER-TICK refresh.
 *
 * `refreshOne` is the whole throttle. A "refresh them all" convenience would look
 * harmless and would reproduce the measured failure it exists to prevent: a flat 60s TTL
 * over four profiles hit 429 after ~19 minutes on a box that also runs claude-pick and
 * the statusline against the same budget.
 */
export class OAuthQuotaPoller {
  private readonly cache = new Map<string, QuotaCacheRecord>();
  private cursor = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly readCredentials: (configDir: string, nowMs: number) => CredentialRead;
  private readonly log: (line: string) => void;
  private readonly timeoutMs: number;

  constructor(opts: OAuthQuotaPollerOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.readCredentials = opts.readCredentials ?? readOAuthCredentials;
    this.log = opts.log ?? ((line) => console.log(`[quota-oauth] ${line}`));
    this.timeoutMs = opts.timeoutMs ?? 6_000;
  }

  /** The measurement held for one profile's config dir, if any. */
  record(configDir: string): QuotaCacheRecord | undefined {
    return this.cache.get(configDir);
  }

  /**
   * Refresh AT MOST ONE profile. The due set is filtered by the utilization-scaled TTL
   * and by any active failure backoff, and the cursor advances over the DUE set so one
   * permanently-failing profile cannot starve the others.
   *
   * The poller holds NO clock: `nowMs` is the tick's time, threaded through the due check,
   * the fetch and the cache merge (CLAUDE.md `nowMs?: number` convention, #1023).
   */
  async refreshOne(profiles: readonly OAuthProfileRef[], nowMs: number = Date.now()): Promise<string | null> {
    const due = profiles.filter((p) => this.isDue(p.configDir, nowMs));
    if (due.length === 0) return null;

    const target = due[this.cursor % due.length];
    this.cursor = (this.cursor + 1) % due.length;

    const outcome = await this.fetchOne(target, nowMs);
    this.cache.set(target.configDir, mergeRecord(this.cache.get(target.configDir), outcome, nowMs));
    return target.profile;
  }

  private isDue(configDir: string, nowMs: number): boolean {
    const rec = this.cache.get(configDir);
    if (!rec) return true;
    if (nowMs < rec.nextTry) return false;
    return nowMs - rec.ts >= refreshIntervalMs(rec);
  }

  private async fetchOne(target: OAuthProfileRef, nowMs: number): Promise<FetchOutcome> {
    const cred = this.readCredentials(target.configDir, nowMs);
    if (cred.err) {
      this.log(`${target.profile} skipped (${cred.err}) — no request sent`);
      return FAILED(cred.err, cred.tier ?? null);
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(OAUTH_USAGE_URL, {
        headers: { authorization: `Bearer ${cred.token}`, "anthropic-beta": OAUTH_BETA },
        signal: ac.signal,
      });
      this.log(`${target.profile} GET ${OAUTH_USAGE_URL} -> ${res.status}`);
      if (!res.ok) {
        const retryAfterSec = res.status === 429
          ? parseRetryAfter(res.headers?.get?.("retry-after") ?? null, nowMs)
          : 0;
        return FAILED(`http-${res.status}`, cred.tier ?? null, retryAfterSec);
      }
      const body = (await res.json()) as Record<string, unknown>;
      return {
        ok: true, err: null, retryAfterSec: 0, tier: cred.tier ?? null,
        fiveH: pickNumber(body.five_hour, "utilization"),
        fiveHReset: pickString(body.five_hour, "resets_at"),
        sevenD: pickNumber(body.seven_day, "utilization"),
        sevenDReset: pickString(body.seven_day, "resets_at"),
      };
    } catch (err) {
      const kind = (err as Error | null)?.name === "AbortError" ? "timeout" : "net";
      this.log(`${target.profile} GET ${OAUTH_USAGE_URL} -> ${kind}`);
      return FAILED(kind, cred.tier ?? null);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** A measurement reduced to what crosses a wire: percentages and their age. */
export interface QuotaReading {
  usedPct5h: number | null;
  usedPct7d: number | null;
  measuredAt: string | null;
  /** Older than one reset window, or never measured. `unknown`, never `exhausted`. */
  stale: boolean;
}

/**
 * Project a cache record onto the percentages-only reading a worker reports.
 *
 * Same staleness rule as the board's own DTO (`buildProviderEntry`): older than one reset
 * window, or never measured, is STALE — which downstream reads as unknown and never as
 * exhausted. A worker whose credentials file has gone (`no-creds`) therefore reports a
 * stale reading rather than a suspiciously healthy 0%.
 */
export function quotaReadingOf(rec: QuotaCacheRecord | undefined, nowMs: number): QuotaReading {
  const stale = rec?.dataTs == null || nowMs - rec.dataTs > MEASUREMENT_STALE_MS;
  return {
    usedPct5h: stale ? null : rec?.fiveH ?? null,
    usedPct7d: stale ? null : rec?.sevenD ?? null,
    measuredAt: rec?.dataTs != null ? new Date(rec.dataTs).toISOString() : null,
    stale,
  };
}
