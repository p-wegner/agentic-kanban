import { existsSync, readdirSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { withTransaction, type Database } from "../db/index.js";
import { getPreference, setPreference } from "../repositories/preferences.repository.js";
import { retargetProviderPolicyProfile } from "./strategy-policy-mutation.js";

/**
 * Generic core for a provider auth-rotation ring.
 *
 * Claude "subscriptions" (CLAUDE_CONFIG_DIR) and Codex "licenses" (CODEX_HOME)
 * are the same machine: a rotation ring of logins, each either an OAuth login
 * pinned to a config DIRECTORY or an API-key login selected by a settings/config
 * PROFILE, with per-login cooldown stamps. The two differ only in field names,
 * dir prefixes, auth-file names, preference keys, the default cooldown window, and
 * a noun. This module holds the identical logic once; each provider file
 * (`claude-subscription-ring.ts`, `codex-license-ring.ts`) supplies an
 * `AuthRingConfig` and re-exports thin, provider-named wrappers so its public
 * API — and the persisted JSON / DTO field names — stay unchanged.
 */

/** Every ring entry has a profile name; provider-specific fields are read via the config accessors. */
export interface BaseRingEntry {
  profile: string;
}

export interface RotationResult {
  rotated: boolean;
  fromProfile: string;
  toProfile?: string;
  reason: string;
}

/** Provider-neutral view of one selectable login (mapped to the provider DTO by each adapter). */
export interface AuthRingInfo {
  profile: string;
  mode: "oauth" | "apikey";
  /** Resolved config directory for an OAuth login; null for an API-key one. */
  dir: string | null;
  /** Settings/config profile name for an API-key login; null for an OAuth one. */
  apiKeyRef: string | null;
  loggedIn: boolean;
  inRing: boolean;
  autoDiscovered: boolean;
}

export interface AuthRingConfig<E extends BaseRingEntry> {
  /**
   * Provider name as used by Strategy Bullseye `providerPolicies[].provider`
   * ("claude" / "codex"). Used by rotation to retarget Bullseye policies that pin
   * the exhausted profile by name, keeping the #903 divergence invariant (#973).
   */
  provider: "claude" | "codex" | "copilot" | "pi";
  /** Config-dir name prefix under the home dir, e.g. ".claude-" / ".codex-". */
  dirPrefix: string;
  /** Files whose presence marks a `<prefix><name>` dir as a discoverable OAuth login. */
  discoverAuthFiles: string[];
  /** Files whose presence proves a config dir is logged in (may differ from discovery). */
  authFiles: string[];
  /** Preference key holding the serialized ring JSON. */
  ringPrefKey: string;
  /** Preference key holding the currently-selected profile. */
  profilePrefKey: string;
  /** Preference key whose `"false"` value disables rotation. */
  rotationDisabledPrefKey: string;
  /** Cooldown preference-key prefix, e.g. "claude_cooldown_" / "codex_cooldown_". */
  cooldownPrefix: string;
  /** Fallback cooldown window when no reset hint is available. */
  defaultCooldownMs: number;
  /** Noun for rotation-reason text: "subscription" / "license" (pluralized with "s"). */
  noun: string;
  /** Profile names (besides "default") that resolve to no config dir, e.g. ["mock"]. */
  skipProfiles: string[];
  /** Build a provider entry from a parsed JSON record (profile already validated non-empty). */
  parseEntry(rec: Record<string, unknown>, profile: string): E;
  /** The config-dir override field on the entry (configDir / codexHome). */
  getDir(entry: E): string | undefined;
  /** The api-key-profile field on the entry (settingsProfile / configToml). */
  getApiKeyRef(entry: E): string | undefined;
}

/** Trim a record string field to a non-empty value, or undefined. Helper for `parseEntry`. */
export function trimmedStringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Inferred config dir for an OAuth login with no explicit override: `~/<prefix><profile>`. */
export function defaultDir<E extends BaseRingEntry>(cfg: AuthRingConfig<E>, profile: string): string {
  return join(homedir(), `${cfg.dirPrefix}${profile}`);
}

/**
 * The config dir this entry should launch under, or undefined for an API-key
 * (api-key-profile) login that needs no dir override. OAuth logins fall back to
 * the inferred default when no explicit dir was set.
 */
export function resolveDir<E extends BaseRingEntry>(cfg: AuthRingConfig<E>, entry: E): string | undefined {
  if (cfg.getApiKeyRef(entry)) return undefined;
  return cfg.getDir(entry)?.trim() || defaultDir(cfg, entry.profile);
}

/**
 * Auto-discover OAuth logins sitting next to the default home dir: any
 * `~/<prefix><name>` directory that holds one of `discoverAuthFiles`. Returns the
 * `<name>` suffixes — what lets a dropped-in login be selected without touching
 * the rotation ring (the ring is only for rotation order + cooldowns).
 */
export function discoverProfiles<E extends BaseRingEntry>(cfg: AuthRingConfig<E>): string[] {
  try {
    return readdirSync(homedir(), { withFileTypes: true })
      .filter((d: Dirent) => d.isDirectory() && d.name.startsWith(cfg.dirPrefix) && d.name.length > cfg.dirPrefix.length)
      .map((d: Dirent) => d.name.slice(cfg.dirPrefix.length))
      .filter((name: string) => {
        const dir = join(homedir(), `${cfg.dirPrefix}${name}`);
        return cfg.discoverAuthFiles.some((f) => existsSync(join(dir, f)));
      });
  } catch {
    return [];
  }
}

/**
 * The config dir a profile should launch under, or undefined for a plain
 * api-key-profile login. Resolution order: explicit ring entry, then an
 * auto-discovered `~/<prefix><name>` directory.
 */
export function resolveDirForProfile<E extends BaseRingEntry>(
  cfg: AuthRingConfig<E>,
  profileName: string | undefined,
  ring: E[],
): string | undefined {
  if (!profileName || profileName === "default" || cfg.skipProfiles.includes(profileName)) return undefined;
  const entry = findRingEntry(ring, profileName);
  if (entry) return resolveDir(cfg, entry);
  const dir = defaultDir(cfg, profileName);
  return existsSync(dir) ? dir : undefined;
}

export function parseRing<E extends BaseRingEntry>(cfg: AuthRingConfig<E>, raw: string | null | undefined): E[] {
  if (!raw || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const ring: E[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const profile = typeof rec.profile === "string" ? rec.profile.trim() : "";
      if (!profile) continue;
      ring.push(cfg.parseEntry(rec, profile));
    }
    return ring;
  } catch {
    return [];
  }
}

export async function loadRing<E extends BaseRingEntry>(cfg: AuthRingConfig<E>, database: Database): Promise<E[]> {
  return parseRing(cfg, await getPreference(cfg.ringPrefKey, database));
}

export function findRingEntry<E extends BaseRingEntry>(ring: E[], profileName: string | undefined): E | undefined {
  if (!profileName || profileName === "default") return undefined;
  return ring.find((e) => e.profile === profileName);
}

/** Profile names contributed by the ring, for surfacing in the profile dropdown. */
export function ringProfileNames<E extends BaseRingEntry>(ring: E[]): string[] {
  return ring.map((e) => e.profile).filter(Boolean);
}

export function makeCooldownKey<E extends BaseRingEntry>(cfg: AuthRingConfig<E>, profile: string): string {
  return `${cfg.cooldownPrefix}${profile}`;
}

/** A login is available if it has no cooldown stamp, or the stamp is in the past. */
function isAvailable<E extends BaseRingEntry>(cfg: AuthRingConfig<E>, profile: string, prefMap: Map<string, string>, nowMs: number): boolean {
  const stamp = prefMap.get(makeCooldownKey(cfg, profile));
  if (!stamp) return true;
  const until = Date.parse(stamp);
  return Number.isNaN(until) || until <= nowMs;
}

/**
 * Pick the next usable login after `currentProfile` in ring order (wrapping),
 * skipping the current one and any whose cooldown has not yet elapsed.
 */
export function pickNext<E extends BaseRingEntry>(
  cfg: AuthRingConfig<E>,
  ring: E[],
  currentProfile: string | undefined,
  prefMap: Map<string, string>,
  now: Date,
): E | undefined {
  if (ring.length === 0) return undefined;
  const nowMs = now.getTime();
  const startIdx = ring.findIndex((e) => e.profile === currentProfile);
  for (let offset = 1; offset <= ring.length; offset++) {
    const entry = ring[(startIdx + offset) % ring.length];
    if (entry.profile === currentProfile) continue;
    if (isAvailable(cfg, entry.profile, prefMap, nowMs)) return entry;
  }
  return undefined;
}

/** Fallback cooldown-until ISO (now + the provider's default window). */
export function fallbackCooldownIso<E extends BaseRingEntry>(cfg: AuthRingConfig<E>, now: Date): string {
  return new Date(now.getTime() + cfg.defaultCooldownMs).toISOString();
}

const BOARD_STRATEGY_PREFIX = "board_strategy_";

/**
 * #973 rotation/Bullseye coherence. Rotation is a LEGITIMATE writer of the global
 * `<provider>_profile` pref, but the #903 write-time guard forbids that pref
 * diverging from the active project's Strategy Bullseye. A Bullseye policy that
 * pins the exhausted profile BY NAME would (a) manufacture exactly that divergence
 * — a later legitimate settings save then 422s on drift it didn't cause — and
 * (b) keep selecting the cooled-down login for Bullseye-driven launches
 * (`selectProviderFromStrategy` reads the policy's `profileName`, not this pref).
 *
 * So rotation retargets every stored Bullseye policy that references the
 * rotated-from profile for this ring's provider, ATOMICALLY with the pref write
 * (#986: one `withTransaction`, so a crash mid-rotation can never leave the pref
 * pointing at the new profile while a Bullseye still pins the old one — exactly
 * the silent divergence the #903 guard exists to prevent) — the "write both
 * sides so the projected map is self-consistent" shape the config-import route
 * uses.
 *
 * The JSON-shape knowledge (which fields make up a Bullseye providerPolicy)
 * lives in `retargetProviderPolicyProfile` (`strategy-policy-mutation.ts`),
 * next to the rest of the Bullseye schema; this module only decides WHICH pref
 * keys are Bullseye blobs. Unparseable configs are skipped, never fatal to the
 * rotation. Objective.md regeneration is deliberately NOT triggered here: the
 * monitors re-read the pref itself (`resolveMonitorTunables` / workspace
 * creation), and conductor objective regeneration remains a Bullseye-save
 * concern.
 */
function computeBullseyeRetargets<E extends BaseRingEntry>(
  cfg: AuthRingConfig<E>,
  prefMap: Map<string, string>,
  fromProfile: string,
  toProfile: string,
): Array<{ key: string; value: string }> {
  const updates: Array<{ key: string; value: string }> = [];
  for (const [key, raw] of prefMap) {
    if (!key.startsWith(BOARD_STRATEGY_PREFIX) || !raw?.trim()) continue;
    const updated = retargetProviderPolicyProfile(raw, cfg.provider, fromProfile, toProfile);
    if (updated !== null) updates.push({ key, value: updated });
  }
  return updates;
}

/**
 * Stamp a cooldown (`until`) on the exhausted login and switch the selected
 * profile to the next usable one. Returns whether a rotation happened. Does NOT
 * relaunch — the caller decides whether/how to restart the affected workspace.
 * `until` is computed by the provider (the reset-hint shape differs per provider).
 */
export async function rotateRing<E extends BaseRingEntry>(
  cfg: AuthRingConfig<E>,
  database: Database,
  prefMap: Map<string, string>,
  currentProfile: string,
  until: string,
  now: Date,
): Promise<RotationResult> {
  const ring = parseRing(cfg, prefMap.get(cfg.ringPrefKey));
  if (ring.length < 2) {
    return { rotated: false, fromProfile: currentProfile, reason: `no ring configured (need >= 2 ${cfg.noun}s)` };
  }
  if (prefMap.get(cfg.rotationDisabledPrefKey) === "false") {
    return { rotated: false, fromProfile: currentProfile, reason: "rotation disabled" };
  }

  // Stamp the exhausted login so we don't immediately rotate back to it.
  await setPreference(makeCooldownKey(cfg, currentProfile), until, database);
  prefMap.set(makeCooldownKey(cfg, currentProfile), until);

  const next = pickNext(cfg, ring, currentProfile, prefMap, now);
  if (!next) {
    return { rotated: false, fromProfile: currentProfile, reason: `all ${cfg.noun}s cooled down` };
  }

  // Keep Bullseye policies pinning the exhausted profile in step with the pref
  // write, so the #903 divergence invariant holds after rotation (#973). The
  // profile write and every retarget commit in ONE transaction (#986): a crash
  // between them would otherwise silently manufacture exactly the divergence
  // the #903 guard forbids. prefMap mirrors the writes only after commit.
  const retargets = computeBullseyeRetargets(cfg, prefMap, currentProfile, next.profile);
  await withTransaction(database, async (tx) => {
    await setPreference(cfg.profilePrefKey, next.profile, tx);
    for (const { key, value } of retargets) {
      await setPreference(key, value, tx);
    }
  }, "auth-rotation profile+Bullseye retarget");
  prefMap.set(cfg.profilePrefKey, next.profile);
  for (const { key, value } of retargets) prefMap.set(key, value);
  return { rotated: true, fromProfile: currentProfile, toProfile: next.profile, reason: `rotated to ${next.profile} (cooled ${currentProfile} until ${until})` };
}

/** True when an OAuth config dir is properly logged in — one of `authFiles` is present. */
export function dirHasAuth<E extends BaseRingEntry>(cfg: AuthRingConfig<E>, dir: string): boolean {
  return cfg.authFiles.some((f) => existsSync(join(dir, f)));
}

/**
 * The unified, provider-neutral view of selectable logins: every auto-discovered
 * `~/<prefix><name>` dir merged with the rotation-ring entries, so a logged-in
 * login shows up even when it isn't (yet) in the ring. Each adapter maps the
 * result to its provider DTO.
 */
export function listAuthRing<E extends BaseRingEntry>(cfg: AuthRingConfig<E>, ring: E[]): AuthRingInfo[] {
  const byProfile = new Map<string, AuthRingInfo>();
  for (const name of discoverProfiles(cfg)) {
    const dir = defaultDir(cfg, name);
    byProfile.set(name, {
      profile: name, mode: "oauth", dir, apiKeyRef: null,
      loggedIn: dirHasAuth(cfg, dir), inRing: false, autoDiscovered: true,
    });
  }
  for (const entry of ring) {
    const autoDiscovered = byProfile.get(entry.profile)?.autoDiscovered ?? false;
    const apiKeyRef = cfg.getApiKeyRef(entry);
    if (apiKeyRef) {
      byProfile.set(entry.profile, {
        profile: entry.profile, mode: "apikey", dir: null, apiKeyRef,
        loggedIn: true, inRing: true, autoDiscovered,
      });
    } else {
      const dir = resolveDir(cfg, entry) ?? null;
      byProfile.set(entry.profile, {
        profile: entry.profile, mode: "oauth", dir, apiKeyRef: null,
        loggedIn: dir ? dirHasAuth(cfg, dir) : false, inRing: true, autoDiscovered,
      });
    }
  }
  return [...byProfile.values()].sort((a, b) => a.profile.localeCompare(b.profile));
}
