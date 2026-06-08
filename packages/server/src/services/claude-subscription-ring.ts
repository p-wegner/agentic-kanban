import { existsSync, readdirSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Database } from "../db/index.js";
import { getPreference, setPreference } from "../repositories/preferences.repository.js";
import { PREF_CLAUDE_SUBSCRIPTION_RING, PREF_CLAUDE_PROFILE } from "../constants/preference-keys.js";

/**
 * One Claude "subscription" in the rotation ring.
 *
 * A Claude `--settings settings_<name>.json` profile only layers env (API keys,
 * base URL) onto the launch — it does NOT carry the OAuth session that backs a
 * Claude Max/Pro plan. The `/login` browser flow writes that session to a single
 * config directory (default `~/.claude`, overridable with `CLAUDE_CONFIG_DIR`).
 * So the only lever to swap which subscription login is live is the
 * `CLAUDE_CONFIG_DIR` env var — a subscription is therefore a directory, not a
 * settings profile. This mirrors Codex's CODEX_HOME-based license rotation
 * (see codex-license-ring.ts).
 *
 * - no `settingsProfile` → OAuth (Max/Pro-plan) subscription. We point
 *   `CLAUDE_CONFIG_DIR` at its dir (explicit `configDir`, else the inferred
 *   default `~/.claude-<profile>`) and DO NOT pass `--settings` (a separate
 *   config dir authenticates via its own login; a named settings_<name>.json
 *   profile would not exist there).
 * - `settingsProfile` set → an API-key / token subscription living as a
 *   `settings_<name>.json` in the shared `~/.claude`. Selected via `--settings`
 *   exactly as before; no `CLAUDE_CONFIG_DIR` override.
 */
export interface ClaudeSubscriptionEntry {
  profile: string;
  configDir?: string;
  settingsProfile?: string;
}

const CLAUDE_CONFIG_DIR_PREFIX = ".claude-";

/** Inferred CLAUDE_CONFIG_DIR for an OAuth subscription with no explicit override: `~/.claude-<profile>`. */
export function defaultClaudeConfigDir(profile: string): string {
  return join(homedir(), `${CLAUDE_CONFIG_DIR_PREFIX}${profile}`);
}

/**
 * The CLAUDE_CONFIG_DIR this subscription should launch under, or undefined for an
 * API-key (settings-profile) subscription that needs no config-dir override. OAuth
 * subscriptions fall back to the inferred default when no explicit `configDir` was set.
 */
export function resolveClaudeConfigDir(entry: ClaudeSubscriptionEntry): string | undefined {
  if (entry.settingsProfile) return undefined;
  return entry.configDir?.trim() || defaultClaudeConfigDir(entry.profile);
}

/**
 * Auto-discover OAuth subscriptions sitting next to the default `~/.claude`: any
 * `~/.claude-<name>` directory that holds a `.credentials.json` or `settings.json`
 * is a first-class Claude profile, exactly like a `~/.claude/settings_<name>.json`.
 * Returns the `<name>` suffixes. This is what lets a dropped-in login be selected /
 * set as default without ever touching the rotation ring (the ring is only for
 * rotation order + cooldowns).
 */
export function discoverClaudeConfigDirProfiles(): string[] {
  try {
    return readdirSync(homedir(), { withFileTypes: true })
      .filter((d: Dirent) => d.isDirectory() && d.name.startsWith(CLAUDE_CONFIG_DIR_PREFIX) && d.name.length > CLAUDE_CONFIG_DIR_PREFIX.length)
      .map((d: Dirent) => d.name.slice(CLAUDE_CONFIG_DIR_PREFIX.length))
      .filter((name: string) => {
        const dir = join(homedir(), `${CLAUDE_CONFIG_DIR_PREFIX}${name}`);
        return existsSync(join(dir, ".credentials.json")) || existsSync(join(dir, "settings.json"));
      });
  } catch {
    return [];
  }
}

/**
 * The CLAUDE_CONFIG_DIR a Claude profile should launch under, or undefined for a
 * plain settings (`--settings`) profile. Resolution order:
 *  1. explicit ring entry — custom `configDir`, or undefined for an API-key `settingsProfile`,
 *  2. an auto-discovered `~/.claude-<name>` directory.
 * Returning a dir tells the launcher to set CLAUDE_CONFIG_DIR and drop `--settings`.
 */
export function resolveClaudeConfigDirForProfile(
  profileName: string | undefined,
  ring: ClaudeSubscriptionEntry[],
): string | undefined {
  if (!profileName || profileName === "default" || profileName === "mock") return undefined;
  const entry = findRingEntry(ring, profileName);
  if (entry) return resolveClaudeConfigDir(entry);
  const dir = defaultClaudeConfigDir(profileName);
  return existsSync(dir) ? dir : undefined;
}

const DEFAULT_COOLDOWN_MS = 5 * 60 * 60 * 1000; // 5h fallback — matches the Claude usage-limit window when resetsAt is absent

export function parseClaudeSubscriptionRing(raw: string | null | undefined): ClaudeSubscriptionEntry[] {
  if (!raw || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const ring: ClaudeSubscriptionEntry[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const profile = typeof rec.profile === "string" ? rec.profile.trim() : "";
      if (!profile) continue;
      const configDir = typeof rec.configDir === "string" && rec.configDir.trim() ? rec.configDir.trim() : undefined;
      const settingsProfile = typeof rec.settingsProfile === "string" && rec.settingsProfile.trim() ? rec.settingsProfile.trim() : undefined;
      ring.push({ profile, configDir, settingsProfile });
    }
    return ring;
  } catch {
    return [];
  }
}

export async function loadClaudeSubscriptionRing(database: Database): Promise<ClaudeSubscriptionEntry[]> {
  return parseClaudeSubscriptionRing(await getPreference(PREF_CLAUDE_SUBSCRIPTION_RING, database));
}

export function findRingEntry(ring: ClaudeSubscriptionEntry[], profileName: string | undefined): ClaudeSubscriptionEntry | undefined {
  if (!profileName || profileName === "default") return undefined;
  return ring.find((e) => e.profile === profileName);
}

/** Profile names contributed by the ring, for surfacing in the Claude profile dropdown. */
export function ringProfileNames(ring: ClaudeSubscriptionEntry[]): string[] {
  return ring.map((e) => e.profile).filter(Boolean);
}

export function cooldownKey(profile: string): string {
  return `claude_cooldown_${profile}`;
}

/** A subscription is available if it has no cooldown stamp, or the stamp is in the past. */
function isAvailable(profile: string, prefMap: Map<string, string>, nowMs: number): boolean {
  const stamp = prefMap.get(cooldownKey(profile));
  if (!stamp) return true;
  const until = Date.parse(stamp);
  return Number.isNaN(until) || until <= nowMs;
}

/**
 * Pick the next usable subscription after `currentProfile` in ring order (wrapping),
 * skipping the current one and any whose cooldown has not yet elapsed.
 */
export function pickNextSubscription(
  ring: ClaudeSubscriptionEntry[],
  currentProfile: string | undefined,
  prefMap: Map<string, string>,
  now: Date,
): ClaudeSubscriptionEntry | undefined {
  if (ring.length === 0) return undefined;
  const nowMs = now.getTime();
  const startIdx = ring.findIndex((e) => e.profile === currentProfile);
  for (let offset = 1; offset <= ring.length; offset++) {
    const entry = ring[(startIdx + offset) % ring.length];
    if (entry.profile === currentProfile) continue;
    if (isAvailable(entry.profile, prefMap, nowMs)) return entry;
  }
  return undefined;
}

/** Turn a Claude "resets at" hint (epoch seconds or ISO) into a cooldown-until ISO string. */
export function cooldownUntilIso(resetsAt: string | number | null | undefined, now: Date): string {
  if (typeof resetsAt === "number" && Number.isFinite(resetsAt)) {
    // Claude rate_limit_event resetsAt is unix epoch seconds.
    const ms = resetsAt > 1e12 ? resetsAt : resetsAt * 1000;
    if (ms > now.getTime()) return new Date(ms).toISOString();
  }
  if (typeof resetsAt === "string" && resetsAt.trim()) {
    const parsed = Date.parse(resetsAt);
    if (!Number.isNaN(parsed) && parsed > now.getTime()) return new Date(parsed).toISOString();
  }
  return new Date(now.getTime() + DEFAULT_COOLDOWN_MS).toISOString();
}

export interface RotationResult {
  rotated: boolean;
  fromProfile: string;
  toProfile?: string;
  reason: string;
}

/**
 * Stamp a cooldown on the exhausted subscription and switch `claude_profile` to the
 * next usable one. Returns whether a rotation happened. Does NOT relaunch — the caller
 * decides whether/how to restart the affected workspace on the new subscription.
 */
export async function rotateClaudeSubscription(
  database: Database,
  prefMap: Map<string, string>,
  currentProfile: string,
  resetsAt: string | number | null | undefined,
  now: Date,
): Promise<RotationResult> {
  const ring = parseClaudeSubscriptionRing(prefMap.get(PREF_CLAUDE_SUBSCRIPTION_RING));
  if (ring.length < 2) {
    return { rotated: false, fromProfile: currentProfile, reason: "no ring configured (need >= 2 subscriptions)" };
  }
  if (prefMap.get("claude_subscription_rotation") === "false") {
    return { rotated: false, fromProfile: currentProfile, reason: "rotation disabled" };
  }

  // Stamp the exhausted subscription so we don't immediately rotate back to it.
  const until = cooldownUntilIso(resetsAt, now);
  await setPreference(cooldownKey(currentProfile), until, database);
  prefMap.set(cooldownKey(currentProfile), until);

  const next = pickNextSubscription(ring, currentProfile, prefMap, now);
  if (!next) {
    return { rotated: false, fromProfile: currentProfile, reason: "all subscriptions cooled down" };
  }

  await setPreference(PREF_CLAUDE_PROFILE, next.profile, database);
  prefMap.set(PREF_CLAUDE_PROFILE, next.profile);
  return { rotated: true, fromProfile: currentProfile, toProfile: next.profile, reason: `rotated to ${next.profile} (cooled ${currentProfile} until ${until})` };
}

/**
 * True when an OAuth (CLAUDE_CONFIG_DIR-based) subscription is properly logged in —
 * i.e. its config dir holds a `.credentials.json`. Used by the profile-health
 * dashboard so a lapsed login shows red. (On macOS the login may live in the
 * keychain instead; treat a `settings.json`-only dir as "present" too.)
 */
export function claudeConfigDirHasAuth(configDir: string): boolean {
  return existsSync(join(configDir, ".credentials.json")) || existsSync(join(configDir, "settings.json"));
}

export interface ClaudeSubscriptionInfo {
  profile: string;
  mode: "oauth" | "apikey";
  /** Resolved CLAUDE_CONFIG_DIR for an OAuth subscription; null for an API-key (settings-profile) one. */
  configDir: string | null;
  settingsProfile: string | null;
  /** OAuth: .credentials.json present. API-key: always true (auth is via the settings env, not a browser). */
  loggedIn: boolean;
  /** Currently part of the rotation ring. */
  inRing: boolean;
  /** Found on disk as a `~/.claude-<name>` dir (vs. only declared in the ring). */
  autoDiscovered: boolean;
}

/**
 * The unified view of selectable Claude subscriptions: every auto-discovered
 * `~/.claude-<name>` dir merged with the rotation-ring entries. The editor renders
 * this so a logged-in subscription shows up even when it isn't (yet) in the ring.
 */
export function listClaudeSubscriptions(ring: ClaudeSubscriptionEntry[]): ClaudeSubscriptionInfo[] {
  const byProfile = new Map<string, ClaudeSubscriptionInfo>();
  for (const name of discoverClaudeConfigDirProfiles()) {
    const dir = defaultClaudeConfigDir(name);
    byProfile.set(name, {
      profile: name, mode: "oauth", configDir: dir, settingsProfile: null,
      loggedIn: claudeConfigDirHasAuth(dir), inRing: false, autoDiscovered: true,
    });
  }
  for (const entry of ring) {
    const autoDiscovered = byProfile.get(entry.profile)?.autoDiscovered ?? false;
    if (entry.settingsProfile) {
      byProfile.set(entry.profile, {
        profile: entry.profile, mode: "apikey", configDir: null, settingsProfile: entry.settingsProfile,
        loggedIn: true, inRing: true, autoDiscovered,
      });
    } else {
      const dir = resolveClaudeConfigDir(entry) ?? null;
      byProfile.set(entry.profile, {
        profile: entry.profile, mode: "oauth", configDir: dir, settingsProfile: null,
        loggedIn: dir ? claudeConfigDirHasAuth(dir) : false, inRing: true, autoDiscovered,
      });
    }
  }
  return [...byProfile.values()].sort((a, b) => a.profile.localeCompare(b.profile));
}
