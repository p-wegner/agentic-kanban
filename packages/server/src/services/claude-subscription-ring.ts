import type { Database } from "../db/index.js";
import { PREF_CLAUDE_SUBSCRIPTION_RING, PREF_CLAUDE_PROFILE } from "../constants/preference-keys.js";
import {
  type AuthRingConfig,
  type RotationResult,
  defaultDir,
  resolveDir,
  resolveDirForProfile,
  discoverProfiles,
  parseRing,
  loadRing,
  findRingEntry as findRingEntryGeneric,
  ringProfileNames as ringProfileNamesGeneric,
  makeCooldownKey,
  pickNext,
  fallbackCooldownIso,
  rotateRing,
  dirHasAuth,
  listAuthRing,
  trimmedStringField,
} from "./auth-rotation-ring.js";

export type { RotationResult };

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
 * (see codex-license-ring.ts); the shared mechanism lives in auth-rotation-ring.ts.
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

const DEFAULT_COOLDOWN_MS = 5 * 60 * 60 * 1000; // 5h fallback — matches the Claude usage-limit window when resetsAt is absent

const CONFIG: AuthRingConfig<ClaudeSubscriptionEntry> = {
  dirPrefix: ".claude-",
  discoverAuthFiles: [".credentials.json", "settings.json"],
  authFiles: [".credentials.json", "settings.json"],
  ringPrefKey: PREF_CLAUDE_SUBSCRIPTION_RING,
  profilePrefKey: PREF_CLAUDE_PROFILE,
  rotationDisabledPrefKey: "claude_subscription_rotation",
  cooldownPrefix: "claude_cooldown_",
  defaultCooldownMs: DEFAULT_COOLDOWN_MS,
  noun: "subscription",
  skipProfiles: ["mock"],
  parseEntry: (rec, profile) => ({
    profile,
    configDir: trimmedStringField(rec.configDir),
    settingsProfile: trimmedStringField(rec.settingsProfile),
  }),
  getDir: (entry) => entry.configDir,
  getApiKeyRef: (entry) => entry.settingsProfile,
};

/** Inferred CLAUDE_CONFIG_DIR for an OAuth subscription with no explicit override: `~/.claude-<profile>`. */
export function defaultClaudeConfigDir(profile: string): string {
  return defaultDir(CONFIG, profile);
}

/**
 * The CLAUDE_CONFIG_DIR this subscription should launch under, or undefined for an
 * API-key (settings-profile) subscription that needs no config-dir override. OAuth
 * subscriptions fall back to the inferred default when no explicit `configDir` was set.
 */
export function resolveClaudeConfigDir(entry: ClaudeSubscriptionEntry): string | undefined {
  return resolveDir(CONFIG, entry);
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
  return discoverProfiles(CONFIG);
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
  return resolveDirForProfile(CONFIG, profileName, ring);
}

export function parseClaudeSubscriptionRing(raw: string | null | undefined): ClaudeSubscriptionEntry[] {
  return parseRing(CONFIG, raw);
}

export async function loadClaudeSubscriptionRing(database: Database): Promise<ClaudeSubscriptionEntry[]> {
  return loadRing(CONFIG, database);
}

export function findRingEntry(ring: ClaudeSubscriptionEntry[], profileName: string | undefined): ClaudeSubscriptionEntry | undefined {
  return findRingEntryGeneric(ring, profileName);
}

/** Profile names contributed by the ring, for surfacing in the Claude profile dropdown. */
export function ringProfileNames(ring: ClaudeSubscriptionEntry[]): string[] {
  return ringProfileNamesGeneric(ring);
}

export function cooldownKey(profile: string): string {
  return makeCooldownKey(CONFIG, profile);
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
  return pickNext(CONFIG, ring, currentProfile, prefMap, now);
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
  return fallbackCooldownIso(CONFIG, now);
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
  return rotateRing(CONFIG, database, prefMap, currentProfile, cooldownUntilIso(resetsAt, now), now);
}

/**
 * True when an OAuth (CLAUDE_CONFIG_DIR-based) subscription is properly logged in —
 * i.e. its config dir holds a `.credentials.json`. Used by the profile-health
 * dashboard so a lapsed login shows red. (On macOS the login may live in the
 * keychain instead; treat a `settings.json`-only dir as "present" too.)
 */
export function claudeConfigDirHasAuth(configDir: string): boolean {
  return dirHasAuth(CONFIG, configDir);
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
  return listAuthRing(CONFIG, ring).map((info) => ({
    profile: info.profile,
    mode: info.mode,
    configDir: info.dir,
    settingsProfile: info.apiKeyRef,
    loggedIn: info.loggedIn,
    inRing: info.inRing,
    autoDiscovered: info.autoDiscovered,
  }));
}
