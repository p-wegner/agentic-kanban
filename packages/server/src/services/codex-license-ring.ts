import { existsSync, readdirSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Database } from "../db/index.js";
import { getPreference, setPreference } from "../repositories/preferences.repository.js";
import { PREF_CODEX_LICENSE_RING } from "../constants/preference-keys.js";

/**
 * One Codex "license" in the rotation ring.
 *
 * A Codex `--profile` only selects model/config — it does NOT carry the OAuth
 * session. The `/login` browser flow writes id/access/refresh tokens to a single
 * `auth.json` inside `CODEX_HOME` (default `~/.codex`). So the only lever to swap
 * which login is live is the `CODEX_HOME` env var. A "license" is therefore a
 * directory, not a profile.
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

const CODEX_HOME_PREFIX = ".codex-";

/** Inferred CODEX_HOME for an OAuth license with no explicit override: `~/.codex-<profile>`. */
export function defaultCodexHome(profile: string): string {
  return join(homedir(), `${CODEX_HOME_PREFIX}${profile}`);
}

/**
 * The CODEX_HOME this license should launch under, or undefined for an API-key
 * (config-toml) license that needs no home override. OAuth licenses fall back to
 * the inferred default when no explicit `codexHome` was set.
 */
export function resolveCodexHome(entry: CodexLicenseEntry): string | undefined {
  if (entry.configToml) return undefined;
  return entry.codexHome?.trim() || defaultCodexHome(entry.profile);
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
  try {
    return readdirSync(homedir(), { withFileTypes: true })
      .filter((d: Dirent) => d.isDirectory() && d.name.startsWith(CODEX_HOME_PREFIX) && d.name.length > CODEX_HOME_PREFIX.length)
      .map((d: Dirent) => d.name.slice(CODEX_HOME_PREFIX.length))
      .filter((name: string) => {
        const dir = join(homedir(), `${CODEX_HOME_PREFIX}${name}`);
        return existsSync(join(dir, "config.toml")) || existsSync(join(dir, "auth.json"));
      });
  } catch {
    return [];
  }
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
  if (!profileName || profileName === "default") return undefined;
  const entry = findRingEntry(ring, profileName);
  if (entry) return resolveCodexHome(entry);
  const home = defaultCodexHome(profileName);
  return existsSync(home) ? home : undefined;
}

const DEFAULT_COOLDOWN_MS = 3 * 60 * 60 * 1000; // 3h fallback when retryAfter is absent/unparseable

export function parseCodexLicenseRing(raw: string | null | undefined): CodexLicenseEntry[] {
  if (!raw || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const ring: CodexLicenseEntry[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const profile = typeof rec.profile === "string" ? rec.profile.trim() : "";
      if (!profile) continue;
      const codexHome = typeof rec.codexHome === "string" && rec.codexHome.trim() ? rec.codexHome.trim() : undefined;
      const configToml = typeof rec.configToml === "string" && rec.configToml.trim() ? rec.configToml.trim() : undefined;
      ring.push({ profile, codexHome, configToml });
    }
    return ring;
  } catch {
    return [];
  }
}

export async function loadCodexLicenseRing(database: Database): Promise<CodexLicenseEntry[]> {
  return parseCodexLicenseRing(await getPreference(PREF_CODEX_LICENSE_RING, database));
}

export function findRingEntry(ring: CodexLicenseEntry[], profileName: string | undefined): CodexLicenseEntry | undefined {
  if (!profileName || profileName === "default") return undefined;
  return ring.find((e) => e.profile === profileName);
}

/** Profile names contributed by the ring, for surfacing in the codex profile dropdown. */
export function ringProfileNames(ring: CodexLicenseEntry[]): string[] {
  return ring.map((e) => e.profile).filter(Boolean);
}

export function cooldownKey(profile: string): string {
  return `codex_cooldown_${profile}`;
}

/** A license is available if it has no cooldown stamp, or the stamp is in the past. */
function isAvailable(profile: string, prefMap: Map<string, string>, nowMs: number): boolean {
  const stamp = prefMap.get(cooldownKey(profile));
  if (!stamp) return true;
  const until = Date.parse(stamp);
  return Number.isNaN(until) || until <= nowMs;
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

/** Turn a codex "try again at X" retryAfter hint into a cooldown-until ISO string. */
export function cooldownUntilIso(retryAfter: string | null | undefined, now: Date): string {
  if (retryAfter) {
    const parsed = Date.parse(retryAfter);
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
  const ring = parseCodexLicenseRing(prefMap.get(PREF_CODEX_LICENSE_RING));
  if (ring.length < 2) {
    return { rotated: false, fromProfile: currentProfile, reason: "no ring configured (need >= 2 licenses)" };
  }
  if (prefMap.get("codex_license_rotation") === "false") {
    return { rotated: false, fromProfile: currentProfile, reason: "rotation disabled" };
  }

  // Stamp the exhausted license so we don't immediately rotate back to it.
  const until = cooldownUntilIso(retryAfter, now);
  await setPreference(cooldownKey(currentProfile), until, database);
  prefMap.set(cooldownKey(currentProfile), until);

  const next = pickNextLicense(ring, currentProfile, prefMap, now);
  if (!next) {
    return { rotated: false, fromProfile: currentProfile, reason: "all licenses cooled down" };
  }

  await setPreference("codex_profile", next.profile, database);
  prefMap.set("codex_profile", next.profile);
  return { rotated: true, fromProfile: currentProfile, toProfile: next.profile, reason: `rotated to ${next.profile} (cooled ${currentProfile} until ${until})` };
}

/**
 * True when an OAuth (CODEX_HOME-based) license is properly logged in — i.e. its
 * home dir holds an `auth.json`. Used by the profile-health dashboard so a lapsed
 * login shows red.
 */
export function codexHomeHasAuth(codexHome: string): boolean {
  return existsSync(join(codexHome, "auth.json"));
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
  const byProfile = new Map<string, CodexLicenseInfo>();
  for (const name of discoverCodexHomeProfiles()) {
    const home = defaultCodexHome(name);
    byProfile.set(name, {
      profile: name, mode: "oauth", codexHome: home, configToml: null,
      loggedIn: codexHomeHasAuth(home), inRing: false, autoDiscovered: true,
    });
  }
  for (const entry of ring) {
    const autoDiscovered = byProfile.get(entry.profile)?.autoDiscovered ?? false;
    if (entry.configToml) {
      byProfile.set(entry.profile, {
        profile: entry.profile, mode: "apikey", codexHome: null, configToml: entry.configToml,
        loggedIn: true, inRing: true, autoDiscovered,
      });
    } else {
      const home = resolveCodexHome(entry) ?? null;
      byProfile.set(entry.profile, {
        profile: entry.profile, mode: "oauth", codexHome: home, configToml: null,
        loggedIn: home ? codexHomeHasAuth(home) : false, inRing: true, autoDiscovered,
      });
    }
  }
  return [...byProfile.values()].sort((a, b) => a.profile.localeCompare(b.profile));
}
