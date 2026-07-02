import type { Database } from "../db/index.js";
import { PREF_CODEX_LICENSE_RING } from "../constants/preference-keys.js";
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
 * One Codex "license" in the rotation ring.
 *
 * A Codex `--profile` only selects model/config — it does NOT carry the OAuth
 * session. The `/login` browser flow writes id/access/refresh tokens to a single
 * `auth.json` inside `CODEX_HOME` (default `~/.codex`). So the only lever to swap
 * which login is live is the `CODEX_HOME` env var. A "license" is therefore a
 * directory, not a profile. This mirrors Claude's CLAUDE_CONFIG_DIR-based
 * subscription rotation (see claude-subscription-ring.ts); the shared mechanism
 * lives in auth-rotation-ring.ts.
 *
 * - no `configToml` → ChatGPT-plan OAuth license. We point `CODEX_HOME` at its dir
 *   (explicit `codexHome`, else the inferred default `~/.codex-<profile>`) and DO NOT
 *   pass `--profile` (the dir authenticates via its own default config; a named
 *   profile would not exist there and codex would exit code 2).
 * - `configToml` set → API-key license living as a `config_<name>.toml` /
 *   `<name>.config.toml` in the shared `~/.codex`. Selected via `--profile` exactly
 *   as before; no `CODEX_HOME` override.
 */
export interface CodexLicenseEntry {
  profile: string;
  codexHome?: string;
  configToml?: string;
}

const DEFAULT_COOLDOWN_MS = 3 * 60 * 60 * 1000; // 3h fallback when retryAfter is absent/unparseable

const CONFIG: AuthRingConfig<CodexLicenseEntry> = {
  provider: "codex",
  dirPrefix: ".codex-",
  discoverAuthFiles: ["config.toml", "auth.json"],
  authFiles: ["auth.json"],
  ringPrefKey: PREF_CODEX_LICENSE_RING,
  profilePrefKey: "codex_profile",
  rotationDisabledPrefKey: "codex_license_rotation",
  cooldownPrefix: "codex_cooldown_",
  defaultCooldownMs: DEFAULT_COOLDOWN_MS,
  noun: "license",
  skipProfiles: [],
  parseEntry: (rec, profile) => ({
    profile,
    codexHome: trimmedStringField(rec.codexHome),
    configToml: trimmedStringField(rec.configToml),
  }),
  getDir: (entry) => entry.codexHome,
  getApiKeyRef: (entry) => entry.configToml,
};

/** Inferred CODEX_HOME for an OAuth license with no explicit override: `~/.codex-<profile>`. */
export function defaultCodexHome(profile: string): string {
  return defaultDir(CONFIG, profile);
}

/**
 * The CODEX_HOME this license should launch under, or undefined for an API-key
 * (config-toml) license that needs no home override. OAuth licenses fall back to
 * the inferred default when no explicit `codexHome` was set.
 */
export function resolveCodexHome(entry: CodexLicenseEntry): string | undefined {
  return resolveDir(CONFIG, entry);
}

/**
 * Auto-discover OAuth licenses sitting next to the default `~/.codex`: any
 * `~/.codex-<name>` directory that holds a `config.toml` or `auth.json` is a
 * first-class codex profile, exactly like a `~/.codex/<name>.config.toml`. Returns
 * the `<name>` suffixes. This is what lets a dropped-in login be selected / set as
 * default without ever touching the rotation ring (the ring is only for rotation
 * order + cooldowns).
 */
export function discoverCodexHomeProfiles(): string[] {
  return discoverProfiles(CONFIG);
}

/**
 * The CODEX_HOME a codex profile should launch under, or undefined for a plain toml
 * (`--profile`) profile. Resolution order:
 *  1. explicit ring entry — custom `codexHome`, or undefined for an API-key `configToml`,
 *  2. an auto-discovered `~/.codex-<name>` directory.
 * Returning a home tells the launcher to set CODEX_HOME and drop `--profile`.
 */
export function resolveCodexHomeForProfile(
  profileName: string | undefined,
  ring: CodexLicenseEntry[],
): string | undefined {
  return resolveDirForProfile(CONFIG, profileName, ring);
}

export function parseCodexLicenseRing(raw: string | null | undefined): CodexLicenseEntry[] {
  return parseRing(CONFIG, raw);
}

export async function loadCodexLicenseRing(database: Database): Promise<CodexLicenseEntry[]> {
  return loadRing(CONFIG, database);
}

export function findRingEntry(ring: CodexLicenseEntry[], profileName: string | undefined): CodexLicenseEntry | undefined {
  return findRingEntryGeneric(ring, profileName);
}

/** Profile names contributed by the ring, for surfacing in the codex profile dropdown. */
export function ringProfileNames(ring: CodexLicenseEntry[]): string[] {
  return ringProfileNamesGeneric(ring);
}

export function cooldownKey(profile: string): string {
  return makeCooldownKey(CONFIG, profile);
}

/**
 * Pick the next usable license after `currentProfile` in ring order (wrapping),
 * skipping the current one and any whose cooldown has not yet elapsed.
 */
export function pickNextLicense(
  ring: CodexLicenseEntry[],
  currentProfile: string | undefined,
  prefMap: Map<string, string>,
  now: Date,
): CodexLicenseEntry | undefined {
  return pickNext(CONFIG, ring, currentProfile, prefMap, now);
}

/** Turn a codex "try again at X" retryAfter hint into a cooldown-until ISO string. */
export function cooldownUntilIso(retryAfter: string | null | undefined, now: Date): string {
  if (retryAfter) {
    const parsed = Date.parse(retryAfter);
    if (!Number.isNaN(parsed) && parsed > now.getTime()) return new Date(parsed).toISOString();
  }
  return fallbackCooldownIso(CONFIG, now);
}

/**
 * Stamp a cooldown on the exhausted license and switch `codex_profile` to the next
 * usable one. Returns whether a rotation happened. Does NOT relaunch — the caller
 * decides whether/how to restart the affected workspace on the new license.
 */
export async function rotateCodexLicense(
  database: Database,
  prefMap: Map<string, string>,
  currentProfile: string,
  retryAfter: string | null | undefined,
  now: Date,
): Promise<RotationResult> {
  return rotateRing(CONFIG, database, prefMap, currentProfile, cooldownUntilIso(retryAfter, now), now);
}

/**
 * True when an OAuth (CODEX_HOME-based) license is properly logged in — i.e. its
 * home dir holds an `auth.json`. Used by the profile-health dashboard so a lapsed
 * login shows red.
 */
export function codexHomeHasAuth(codexHome: string): boolean {
  return dirHasAuth(CONFIG, codexHome);
}

export interface CodexLicenseInfo {
  profile: string;
  mode: "oauth" | "apikey";
  /** Resolved CODEX_HOME for an OAuth license; null for an API-key (config-toml) one. */
  codexHome: string | null;
  configToml: string | null;
  /** OAuth: auth.json present. API-key: always true (login is via the key, not a browser). */
  loggedIn: boolean;
  /** Currently part of the rotation ring. */
  inRing: boolean;
  /** Found on disk as a `~/.codex-<name>` dir (vs. only declared in the ring). */
  autoDiscovered: boolean;
}

/**
 * The unified view of selectable Codex licenses: every auto-discovered
 * `~/.codex-<name>` dir merged with the rotation-ring entries. The editor renders
 * this so a logged-in license shows up even when it isn't (yet) in the ring.
 */
export function listCodexLicenses(ring: CodexLicenseEntry[]): CodexLicenseInfo[] {
  return listAuthRing(CONFIG, ring).map((info) => ({
    profile: info.profile,
    mode: info.mode,
    codexHome: info.dir,
    configToml: info.apiKeyRef,
    loggedIn: info.loggedIn,
    inRing: info.inRing,
    autoDiscovered: info.autoDiscovered,
  }));
}
