/**
 * Per-project profile allowlist — a HARD constraint on which provider profiles a
 * project's sessions may launch under.
 *
 * ## Why this is not the Strategy Bullseye
 *
 * `board_strategy_<projectId>` already expresses a per-project provider/profile
 * *preference*: a priority list with quota-aware fallback. It is a SELECTOR, and it is
 * deliberately permissive — `fill`/`throttle` policies fall through to the next policy
 * when quota blocks the preferred one, and `resolveProviderConfig` puts an explicit
 * per-workspace profile override ABOVE it. Both behaviours are correct for "which
 * profile would we rather use", and both are wrong for "which profiles is this project
 * ALLOWED to use".
 *
 * The distinction has teeth when a profile maps to a subscription that must not be
 * spent on the wrong work: a project pinned to one client's Claude login must not drift
 * onto another account because a rate limit fired, because a human clicked a different
 * profile in the launch dialog, or because the global rotation ring rewrote
 * `claude_profile`. Selection order cannot express that, so this is a separate filter
 * applied LAST, after every selector has had its say.
 *
 * ## Semantics
 *
 * - **Absent or empty** → unrestricted. This is the default for every project, so
 *   adding the setting changes nothing until someone fills it in.
 * - **Non-empty** → the resolved selection is clamped into the list. Clamping is
 *   reported, never silent (`ProfileClampResult.note`), because a launch that quietly
 *   ignores the operator's explicit profile choice is indistinguishable from a bug.
 * - **Cooling entries are skipped, in list order** (rotate-within-allowlist). Cooldowns
 *   are the same `<provider>_cooldown_<profile>` stamps the rotation rings write, read
 *   straight off the preference map, so a limit hit by the ring is honoured here too.
 * - **Every entry cooling** → HOLD. `selection` is null and `holdReason` says which
 *   profiles are cooling and until when. The caller must not launch: falling back to an
 *   out-of-list profile would break the restriction at exactly the moment it matters.
 * - **Present but unparseable** → also HOLD, never "unrestricted". A kill-switch that
 *   fails open is not a kill-switch (same reasoning as `START_MODE_VALUES` in
 *   `dynamic-preference-keys.ts`: validate and refuse, don't coerce). The write path
 *   rejects malformed values, so this only fires for a value edited around the API.
 *
 * PURE and client-safe: no node builtins, so the Settings UI can preview the same
 * decision the server will make.
 */
import type { AgentProviderName } from "./provider-traits.js";
import { narrowProvider, profileOptionLabel } from "./provider-traits.js";
import { projectPref } from "./dynamic-preference-keys.js";

const allowedProfilesPrefDef = projectPref("allowed_profiles");

/**
 * The per-project allowlist preference key. Lives here rather than in the server's
 * runtime-config service so the Settings editor writes the exact key the resolver reads —
 * a client-side copy of the string is how the `verify_script_<id>` family drifted.
 */
export function allowedProfilesPrefKey(projectId: string): string {
  return allowedProfilesPrefDef.key(projectId);
}

/** One permitted `{provider, profile}` pair. */
export interface AllowedProfile {
  provider: AgentProviderName;
  name: string;
}

/**
 * A parsed allowlist. `entries` is empty for BOTH "no restriction" and "restricted to
 * nothing", which must not be confused — `malformed` is what separates them.
 */
export interface ParsedProfileAllowlist {
  /** Permitted pairs, in operator-declared priority order, deduped. */
  entries: AllowedProfile[];
  /** True when the stored value was present but could not be understood at all. */
  malformed: boolean;
  /** True when a restriction is in force (a non-empty list, or a malformed one). */
  restricted: boolean;
}

export interface ProfileClampResult {
  /** The profile to launch under, or null when the caller must HOLD. */
  selection: AllowedProfile | null;
  /** True when `selection` differs from what was asked for. */
  clamped: boolean;
  /** Why the caller must not launch. Null whenever `selection` is non-null. */
  holdReason: string | null;
  /** Human-readable diagnostics for the caller to log. Never empty when clamped/holding. */
  note: string | null;
}

/** The cooldown stamp key the rotation rings write for a profile (`auth-rotation-ring.ts`). */
export function profileCooldownKey(provider: AgentProviderName, profile: string): string {
  return `${provider}_cooldown_${profile}`;
}

/**
 * True when this profile has no cooldown stamp, or the stamp has elapsed. Mirrors
 * `isAvailable` in `auth-rotation-ring.ts`, including its tolerance: an unparseable
 * stamp counts as available rather than pinning a profile off forever.
 */
export function isProfileCooling(
  entry: AllowedProfile,
  prefMap: Map<string, string>,
  nowMs: number,
): boolean {
  const stamp = prefMap.get(profileCooldownKey(entry.provider, entry.name));
  if (!stamp) return false;
  const until = Date.parse(stamp);
  if (Number.isNaN(until)) return false;
  return until > nowMs;
}

function normalizeEntry(value: unknown): AllowedProfile | null {
  // `"claude:andrena_team_5x_2"` — the compact form, matching a Bullseye policy id.
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    const colon = text.indexOf(":");
    // A bare name means claude, which is the board's own default provider. Being lenient
    // here is safe: the provider is re-tagged, not guessed away.
    if (colon < 0) return { provider: "claude", name: text };
    const name = text.slice(colon + 1).trim();
    if (!name) return null;
    return { provider: narrowProvider(text.slice(0, colon)), name };
  }
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const rawName = typeof rec.name === "string" ? rec.name : typeof rec.profileName === "string" ? rec.profileName : "";
    const name = rawName.trim();
    if (!name) return null;
    return { provider: narrowProvider(typeof rec.provider === "string" ? rec.provider : undefined), name };
  }
  return null;
}

/** `provider:name`, the stable identity used for dedupe and comparison. */
export function allowedProfileId(entry: AllowedProfile): string {
  return `${entry.provider}:${entry.name}`;
}

/**
 * Parse the stored `allowed_profiles_<projectId>` value.
 *
 * Accepts a JSON array of `{provider, name}` objects (the canonical form the UI writes),
 * of `"provider:name"` strings, or a bare comma-separated string for hand-editing
 * convenience. An array that parses but yields no usable entry is MALFORMED, not empty —
 * `[{"provider":"claude"}]` is a botched restriction, not the absence of one.
 */
export function parseProfileAllowlist(raw: string | null | undefined): ParsedProfileAllowlist {
  const text = (raw ?? "").trim();
  if (!text) return { entries: [], malformed: false, restricted: false };

  let source: unknown[] | null = null;
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      source = Array.isArray(parsed) ? parsed : null;
    } catch {
      source = null;
    }
  } else {
    // Not JSON — treat as a comma-separated list of compact ids.
    source = text.split(",");
  }
  if (!source) return { entries: [], malformed: true, restricted: true };

  // An explicit empty array is the one way to say "restriction removed" without deleting
  // the row, so it is empty-and-well-formed rather than malformed.
  if (source.length === 0) return { entries: [], malformed: false, restricted: false };

  const entries: AllowedProfile[] = [];
  const seen = new Set<string>();
  for (const raw of source) {
    const entry = normalizeEntry(raw);
    if (!entry) continue;
    const id = allowedProfileId(entry);
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push(entry);
  }
  if (entries.length === 0) return { entries: [], malformed: true, restricted: true };
  return { entries, malformed: false, restricted: true };
}

/** Serialize back to the canonical stored form. */
export function serializeProfileAllowlist(entries: AllowedProfile[]): string {
  return JSON.stringify(entries.map((e) => ({ provider: e.provider, name: e.name })));
}

export function isProfileAllowed(
  allowlist: ParsedProfileAllowlist,
  provider: string | null | undefined,
  profileName: string | null | undefined,
): boolean {
  if (!allowlist.restricted) return true;
  const name = (profileName ?? "").trim();
  if (!name) return false;
  const id = allowedProfileId({ provider: narrowProvider(provider), name });
  return allowlist.entries.some((e) => allowedProfileId(e) === id);
}

function describeCooling(entries: AllowedProfile[], prefMap: Map<string, string>): string {
  return entries
    .map((e) => {
      const until = prefMap.get(profileCooldownKey(e.provider, e.name));
      return until ? `${allowedProfileId(e)} until ${until}` : allowedProfileId(e);
    })
    .join(", ");
}

/**
 * Clamp a resolved provider/profile into the project's allowlist, skipping cooling
 * entries in declared order.
 *
 * Returns the selection to launch under, or a hold. Callers MUST check `holdReason`
 * before launching — an unchecked null `selection` would otherwise read as "no opinion"
 * and let the caller proceed on the unrestricted choice, which is the failure this whole
 * module exists to prevent.
 */
export function clampProfileToAllowlist(input: {
  allowlist: ParsedProfileAllowlist;
  provider: string | null | undefined;
  profileName: string | null | undefined;
  prefMap: Map<string, string>;
  nowMs: number;
}): ProfileClampResult {
  const { allowlist, prefMap, nowMs } = input;
  const unrestricted: ProfileClampResult = { selection: null, clamped: false, holdReason: null, note: null };
  if (!allowlist.restricted) return unrestricted;

  if (allowlist.malformed) {
    return {
      selection: null,
      clamped: false,
      holdReason: "profile allowlist is set but unparseable — refusing to launch on an unrestricted profile",
      note: "profile allowlist unparseable; holding rather than falling back (fail closed)",
    };
  }

  const requestedName = (input.profileName ?? "").trim();
  const requested: AllowedProfile | null = requestedName
    ? { provider: narrowProvider(input.provider), name: requestedName }
    : null;

  const usable = allowlist.entries.filter((e) => !isProfileCooling(e, prefMap, nowMs));
  if (usable.length === 0) {
    return {
      selection: null,
      clamped: false,
      holdReason: `every allowed profile is cooling (${describeCooling(allowlist.entries, prefMap)})`,
      note: `profile allowlist exhausted: ${describeCooling(allowlist.entries, prefMap)}`,
    };
  }

  // The requested profile is permitted and usable — nothing to do. This is the common
  // path once a project is configured, so it must stay free of notes/log noise.
  if (requested && usable.some((e) => allowedProfileId(e) === allowedProfileId(requested))) {
    return { selection: requested, clamped: false, holdReason: null, note: null };
  }

  const chosen = usable[0];
  const reason = !requested
    ? "no profile resolved"
    : isProfileAllowed(allowlist, requested.provider, requested.name)
      ? `${allowedProfileId(requested)} is cooling`
      : `${allowedProfileId(requested)} is not allowed for this project`;
  return {
    selection: chosen,
    clamped: true,
    holdReason: null,
    note: `profile allowlist: ${reason} → launching on ${profileOptionLabel(chosen.provider, chosen.name)}`,
  };
}

/**
 * #651 — may this project's work be dispatched to a FLEET WORKER at all?
 *
 * The allowlist is a hard constraint on the board: `resolveProjectRuntimeConfig` clamps
 * or holds, so a restricted project cannot launch on an unlisted account. A worker is a
 * different machine: it authenticates the agent with its OWN local login, and the board
 * deliberately sends no credentials (decision 012 — `CLAUDE_CONFIG_DIR` is not in
 * `REMOTE_SPEC_ENV_ALLOWLIST`, by design). So the board picks a permitted profile,
 * records it, and the worker then runs under whatever account that machine is logged
 * into. The credential correctly does not travel — but neither did the CONSTRAINT, and
 * nothing refused the dispatch, so a project restricted for billing/tenancy separation
 * silently lost its guarantee the moment it went remote.
 *
 * The rule here is the same one `clampProfileToAllowlist` already applies: for a project
 * pinned to a specific subscription, the wrong account is worse than no progress. A
 * restricted project therefore does not place remotely. The caller decides what "does
 * not place" means — host fallback (the board CAN enforce there) for a normal project,
 * a refusal for a strict one that forbids the host.
 *
 * A malformed value blocks too: `parseProfileAllowlist` reports it as `restricted`, and
 * failing closed on an unreadable restriction is the whole point of that flag.
 *
 * This is deliberately not the last word. Worker-side ATTESTATION — the worker declaring
 * which profiles/config dirs it can authenticate as, the way it already declares
 * `--providers` and `--labels` — would let a restricted project dispatch to a worker
 * that can prove it satisfies the list. That check would go right here, narrowing the
 * block instead of replacing it.
 */
export function remoteDispatchBlockedByAllowlist(
  allowlistRaw: string | null | undefined,
): { blocked: false } | { blocked: true; reason: string } {
  const allowlist = parseProfileAllowlist(allowlistRaw);
  if (!allowlist.restricted) return { blocked: false };
  const detail = allowlist.malformed
    ? "its profile allowlist is present but unreadable"
    : `it is restricted to [${allowlist.entries.map(allowedProfileId).join(", ")}]`;
  return {
    blocked: true,
    reason:
      `${detail}, and a fleet worker authenticates with its own machine-local login ` +
      "(the board sends no credentials), so the restriction cannot be enforced there",
  };
}
