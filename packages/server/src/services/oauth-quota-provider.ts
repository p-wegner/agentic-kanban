/**
 * Quota, read from the OAuth usage endpoint with each profile's OWN token (#1023).
 *
 * The Bullseye's provider policy gates on a `QuotaUsageProvider`. The only
 * implementation until now was `TampermonkeyQuotaProvider`, bound to a local
 * browser-extension service on :8742 that is effectively never running — so
 * `isPolicyBlockedByQuota` always saw `null` and selection degraded to the static
 * priority order, with the auth-rotation ring only reacting AFTER a usage-limit
 * message appeared. This provider is the forward-looking source: it reads
 * `api/oauth/usage` per Claude profile, which is where the 5-hour and 7-day windows
 * actually live.
 *
 * ── Why this file is so defensive ────────────────────────────────────────────
 * The logic is PORTED (not imported — the board must run without claude-pick on the
 * box) from `claude-pick/fleet/lib/usage.mjs`, which already paid for the traps:
 *
 *   - `api/oauth/usage` 429s easily, and several pollers share one budget on a dev
 *     machine (claude-pick itself, the statusline, this board). So: **one profile
 *     per tick, round-robin**, never a burst across profiles.
 *   - The refresh TTL scales with how close a profile is to its cap. A 5-hour window
 *     at 4% does not change meaningfully in a minute; one at 95% does. Measured in
 *     the reference: a flat 60s TTL over four profiles hit 429 after ~19 minutes.
 *   - A failure BACKS OFF (429 honours `Retry-After`) and keeps the last good
 *     gauges. A rate limit is not an exhausted subscription — treating it as one
 *     would take a perfectly usable profile out of rotation, which is the exact
 *     failure this provider exists to prevent.
 *   - Every outbound request is logged, so if the board ever causes a 429 that some
 *     other poller sees, the audit trail exists.
 *
 * ── Old beats wrong ──────────────────────────────────────────────────────────
 * A measurement older than one reset window ({@link MEASUREMENT_STALE_MS}) reads as
 * `unknown` — NOT as exhausted and NOT as empty. `isPolicyBlockedByQuota` only
 * blocks on `status === "ok"`, so an `unknown` profile falls back to the static
 * priority order (it is sorted behind fresh ones by the caller) instead of being
 * dropped. Blanking the gauges instead would lose information the operator can
 * still judge for themselves once the age is on screen.
 *
 * Credentials are located through the board's OWN profile discovery
 * (`claude-subscription-ring.ts` → `listClaudeSubscriptions` / the ring's config-dir
 * resolution). There is deliberately no second credential path here.
 */
import type { QuotaMetric, QuotaProviderEntry, QuotaUsageResult } from "@agentic-kanban/shared";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { QuotaUsageProvider } from "./quota-usage.service.js";
import { listClaudeSubscriptions, type ClaudeSubscriptionEntry } from "./claude-subscription-ring.js";

export const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/** Beta header the OAuth usage endpoint requires. */
const OAUTH_BETA = "oauth-2025-04-20";

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * One reset window. A measurement older than this is `unknown`: the 5-hour window it
 * describes has certainly reset since, so the number is not merely stale, it is about
 * a window that no longer exists.
 */
export const MEASUREMENT_STALE_MS = FIVE_HOURS_MS;

/** Accent used for every Claude profile card, matching the provider's brand colour. */
const CLAUDE_ACCENT = "#d97757";
const CLAUDE_LOGIN_URL = "https://claude.ai/login";

/** A profile the provider can poll: a name plus the config dir holding its OAuth login. */
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

/**
 * Every OAuth Claude profile the board can see, via the ring's own discovery. API-key
 * (`settingsProfile`) subscriptions are skipped: they authenticate through a settings
 * env, hold no OAuth session, and so have nothing to read here.
 *
 * The DEFAULT profile (`CLAUDE_CONFIG_DIR`, else `~/.claude`) is included explicitly —
 * discovery only enumerates `~/.claude-<name>` siblings, but the default dir is the
 * ring's own documented home for the default login and is usually the busiest one.
 */
export function listOAuthProfiles(ring: ClaudeSubscriptionEntry[] = []): OAuthProfileRef[] {
  const out: OAuthProfileRef[] = [];
  const defaultDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  if (existsSync(join(defaultDir, ".credentials.json"))) {
    out.push({ profile: "default", configDir: defaultDir });
  }
  for (const sub of listClaudeSubscriptions(ring)) {
    if (sub.mode !== "oauth" || !sub.configDir) continue;
    if (out.some((p) => p.configDir === sub.configDir || p.profile === sub.profile)) continue;
    out.push({ profile: sub.profile, configDir: sub.configDir });
  }
  return out;
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

const FAILED = (err: string, tier: string | null = null, retryAfterSec = 0): FetchOutcome => ({
  ok: false, err, retryAfterSec, tier,
  fiveH: null, fiveHReset: null, sevenD: null, sevenDReset: null,
});

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

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

export interface OAuthQuotaProviderOptions {
  /** Injected for tests. Defaults to the global `fetch`; a test MUST pass a fake. */
  fetchImpl?: typeof fetch;
  /** Injected for tests. Defaults to the ring-backed discovery above. */
  listProfiles?: () => OAuthProfileRef[];
  /** Injected for tests. Defaults to reading `<configDir>/.credentials.json`. */
  readCredentials?: (configDir: string, nowMs: number) => CredentialRead;
  /** Every outbound request is logged through here. Defaults to the board's console prefix. */
  log?: (line: string) => void;
  timeoutMs?: number;
}

/**
 * The `QuotaUsageProvider` the board runs by default.
 *
 * `fetchUsage()` is ONE TICK: it refreshes at most one profile (the stalest due one,
 * round-robin) and then renders the whole cache. So a UI poll, a monitor cycle and an
 * objective regeneration each cost at most one upstream request, and five profiles
 * converge over five ticks instead of bursting together.
 *
 * The provider holds NO clock: `fetchUsage(nowMs?)` takes the tick's time and threads it
 * through the whole tick (due check, fetch, cache merge, rendering), per the CLAUDE.md
 * `nowMs?: number` time-injection convention.
 */
export class OAuthQuotaProvider implements QuotaUsageProvider {
  private readonly cache = new Map<string, QuotaCacheRecord>();
  private cursor = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly listProfiles: () => OAuthProfileRef[];
  private readonly readCredentials: (configDir: string, nowMs: number) => CredentialRead;
  private readonly log: (line: string) => void;
  private readonly timeoutMs: number;

  constructor(opts: OAuthQuotaProviderOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.listProfiles = opts.listProfiles ?? (() => listOAuthProfiles());
    this.readCredentials = opts.readCredentials ?? readOAuthCredentials;
    this.log = opts.log ?? ((line) => console.log(`[quota-oauth] ${line}`));
    this.timeoutMs = opts.timeoutMs ?? 6_000;
  }

  async fetchUsage(nowMs: number = Date.now()): Promise<QuotaUsageResult> {
    const profiles = this.listProfiles();
    await this.refreshOne(profiles, nowMs);
    return {
      providers: profiles.map((p) => this.toEntry(p, nowMs)),
      scrapedAt: new Date(nowMs).toISOString(),
    };
  }

  /**
   * Refresh AT MOST ONE profile. The due set is filtered by the utilization-scaled TTL
   * and by any active failure backoff, and the cursor advances over the DUE set so one
   * permanently-failing profile cannot starve the others.
   */
  private async refreshOne(profiles: OAuthProfileRef[], nowMs: number): Promise<string | null> {
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

  private toEntry(p: OAuthProfileRef, nowMs: number): QuotaProviderEntry {
    return buildProviderEntry(p.profile, this.cache.get(p.configDir), nowMs);
  }
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

function metric(
  label: string,
  percent: number | null,
  resetIso: string | null,
  periodMs: number,
  nowMs: number,
): QuotaMetric {
  const resetAt = resetIso ? Date.parse(resetIso) : NaN;
  const hasReset = Number.isFinite(resetAt);
  return {
    label,
    percent,
    detail: null,
    resetAt: hasReset ? resetAt : null,
    resetIso: hasReset ? new Date(resetAt).toISOString() : null,
    resetInSeconds: hasReset ? Math.max(0, Math.round((resetAt - nowMs) / 1000)) : null,
    periodMs,
  };
}

/**
 * Map one cache record onto the wire DTO.
 *
 * Status, in the order it is decided:
 *  - no login at all (`no-creds`/`bad-creds`/`no-token`/`expired`) → `auth`, so the UI
 *    offers the sign-in link rather than pretending the number is missing.
 *  - the measurement is older than one reset window (or was never taken) → `unknown`.
 *    Never `error`, never "0%": `isPolicyBlockedByQuota` only blocks on `ok`, so an
 *    `unknown` profile stays selectable on the static order instead of being dropped.
 *  - otherwise → `ok`, with the last-known gauges and their age.
 */
export function buildProviderEntry(
  profile: string,
  rec: QuotaCacheRecord | undefined,
  nowMs: number,
): QuotaProviderEntry {
  const base = {
    id: profile,
    label: `Claude: ${profile}`,
    accent: CLAUDE_ACCENT,
    loginUrl: CLAUDE_LOGIN_URL,
    transport: "http" as const,
  };
  const authErrs = ["no-creds", "bad-creds", "no-token", "expired"];
  if (rec && !rec.ok && authErrs.includes(rec.err ?? "")) {
    return {
      ...base, hasCreds: rec.err !== "no-creds", status: "auth",
      plan: rec.tier ?? undefined, metrics: [],
      measuredAt: null, ageSeconds: null, stale: true,
      error: `login unusable (${rec.err})`,
    };
  }

  const ageSeconds = rec?.dataTs != null ? Math.max(0, Math.round((nowMs - rec.dataTs) / 1000)) : null;
  const stale = rec?.dataTs == null || nowMs - rec.dataTs > MEASUREMENT_STALE_MS;
  const metrics = rec?.dataTs != null
    ? [
        metric("5-hour window", rec.fiveH, rec.fiveHReset, FIVE_HOURS_MS, nowMs),
        metric("7-day window", rec.sevenD, rec.sevenDReset, SEVEN_DAYS_MS, nowMs),
      ]
    : [];

  return {
    ...base,
    hasCreds: true,
    status: stale ? "unknown" : "ok",
    plan: rec?.tier ?? undefined,
    metrics,
    measuredAt: rec?.dataTs != null ? new Date(rec.dataTs).toISOString() : null,
    ageSeconds,
    stale,
    error: rec && !rec.ok && rec.err ? `last refresh failed (${rec.err})` : undefined,
  };
}

/**
 * NOTE on the rotation ring: `listOAuthProfiles` is called with no ring, deliberately.
 * The ring lives in a preference row, and this provider is constructed before (and
 * independently of) any request context; reading it would make the module DB-bound for
 * a value that only ADDS profiles beyond the ones already discoverable on disk.
 * `listClaudeSubscriptions([])` still returns every auto-discovered `~/.claude-<name>`
 * login — i.e. every OAuth profile that has a token to read. The one case this misses is
 * a ring-only entry with a custom `configDir`; it appears as soon as that dir exists
 * under the default naming, and a caller that HAS the ring can pass it in via
 * `listProfiles`.
 */
