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
 * ── Where the engine lives ───────────────────────────────────────────────────
 * The throttle, the cache and the fetch are `../lib/oauth-quota-core.js`
 * since #1027, because a fleet WORKER reports its own profiles' quota with the same
 * reader and cannot import this package (`worker-cli-isolation.test.ts`). This file keeps
 * the two board-shaped halves: discovery through the rotation ring, and the wire DTO.
 *
 * The engine's logic is PORTED (not imported — the board must run without claude-pick on
 * the box) from `claude-pick/fleet/lib/usage.mjs`, which already paid for the traps:
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
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  FIVE_HOURS_MS,
  MEASUREMENT_STALE_MS,
  OAuthQuotaPoller,
  SEVEN_DAYS_MS,
  readOAuthCredentials,
  type CredentialRead,
  type OAuthProfileRef,
  type QuotaCacheRecord,
} from "../lib/oauth-quota-core.js";
import type { QuotaUsageProvider } from "./quota-usage.service.js";
import { listClaudeSubscriptions, type ClaudeSubscriptionEntry } from "./claude-subscription-ring.js";

/**
 * The engine's surface, re-exported unchanged (#1027).
 *
 * ~20 call sites and this provider's own test suite import these from here, and the move
 * to `server/src/lib/oauth-quota-core` was an extraction, not a redesign — so the import path
 * stays valid rather than becoming a mechanical sweep with nothing to show for it.
 */
export {
  MEASUREMENT_STALE_MS,
  OAUTH_USAGE_URL,
  backoffMs,
  mergeRecord,
  parseRetryAfter,
  quotaReadingOf,
  readOAuthCredentials,
  refreshIntervalMs,
  tierOf,
} from "../lib/oauth-quota-core.js";
export type {
  CredentialRead,
  FetchOutcome,
  OAuthProfileRef,
  QuotaCacheRecord,
  QuotaReading,
} from "../lib/oauth-quota-core.js";

/** Accent used for every Claude profile card, matching the provider's brand colour. */
const CLAUDE_ACCENT = "#d97757";
const CLAUDE_LOGIN_URL = "https://claude.ai/login";

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
  private readonly poller: OAuthQuotaPoller;
  private readonly listProfiles: () => OAuthProfileRef[];

  constructor(opts: OAuthQuotaProviderOptions = {}) {
    this.listProfiles = opts.listProfiles ?? (() => listOAuthProfiles());
    this.poller = new OAuthQuotaPoller({
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      readCredentials: opts.readCredentials ?? readOAuthCredentials,
      log: opts.log ?? ((line) => console.log(`[quota-oauth] ${line}`)),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
  }

  async fetchUsage(nowMs: number = Date.now()): Promise<QuotaUsageResult> {
    const profiles = this.listProfiles();
    await this.poller.refreshOne(profiles, nowMs);
    return {
      providers: profiles.map((p) => buildProviderEntry(p.profile, this.poller.record(p.configDir), nowMs)),
      scrapedAt: new Date(nowMs).toISOString(),
    };
  }
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
 *  - no login at all (`no-creds`/`bad-creds`/`no-token`/`expired`) -> `auth`, so the UI
 *    offers the sign-in link rather than pretending the number is missing.
 *  - the measurement is older than one reset window (or was never taken) -> `unknown`.
 *    Never `error`, never "0%": `isPolicyBlockedByQuota` only blocks on `ok`, so an
 *    `unknown` profile stays selectable on the static order instead of being dropped.
 *  - otherwise -> `ok`, with the last-known gauges and their age.
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
