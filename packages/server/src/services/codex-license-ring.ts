import { existsSync } from "node:fs";
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
 * - `codexHome` set  → ChatGPT-plan OAuth license. We point `CODEX_HOME` at that
 *   dir and DO NOT pass `--profile` (the dir authenticates via its own default
 *   config; a named profile would not exist there and codex would exit code 2).
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
