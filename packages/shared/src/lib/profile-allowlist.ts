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
 * ## Since #1025 this module is the ROSTER's front door
 *
 * An allowlist is one point on a larger scale: a flat list is a roster in which every
 * entry is `pool`. `profile-roster.ts` (parse + the narrowing rule) and
 * `profile-roster-selection.ts` (the decision, including `reserve` and `forbidden`) hold
 * that generalization, and everything below is expressed in terms of them — so there is
 * exactly ONE selection algorithm rather than a legacy path and a roster path that can
 * disagree about a cooldown. The `allowlist` names stay because ~20 call sites and the
 * Settings editor use them, and because "allowlist" is still the honest word for the
 * migrated, all-`pool` case.
 *
 * PURE and client-safe: no node builtins, so the Settings UI can preview the same
 * decision the server will make.
 */
import type { AgentProviderName } from "./provider-traits.js";
import { narrowProvider } from "./provider-traits.js";
import { projectPref } from "./dynamic-preference-keys.js";
import type { ParsedRoster, ProfileRef } from "./profile-roster.js";
import { parseRoster, profileRefId } from "./profile-roster.js";
import { resolveRosterSelection } from "./profile-roster-selection.js";

const allowedProfilesPrefDef = projectPref("allowed_profiles");

/** The roster surface, re-exported so one import path serves both spellings. */
export {
  DEFAULT_POOL_EXHAUSTED_PCT,
  DEFAULT_PROFILE_ROLE,
  PROFILE_ROLES,
  RESERVE_OK_TAG,
  isProfileCooling,
  isProfileRole,
  mostRestrictiveRole,
  parseRoster,
  profileCooldownKey,
  profileRefId,
  reserveAllowedPrefKey,
  resolvePoolExhaustedPct,
  resolveProjectRoster,
  resolveReserveAllowance,
  rosterExhaustedPctPrefKey,
  rosterPrefKey,
  serializeRoster,
} from "./profile-roster.js";
export type { ParsedRoster, ProfileRef, ProfileRole, RosterEntry } from "./profile-roster.js";
export {
  headroomFromQuotaUsage,
  headroomRecordFor,
  rankRosterEntries,
  resolveRosterSelection,
} from "./profile-roster-selection.js";
export type {
  ProfileHeadroom,
  RosterSelection,
  RosterSelectionInput,
} from "./profile-roster-selection.js";

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

/** `provider:name`, the stable identity used for dedupe and comparison. */
export function allowedProfileId(entry: ProfileRef): string {
  return profileRefId(entry);
}

/**
 * Parse the stored `allowed_profiles_<projectId>` value.
 *
 * Accepts a JSON array of `{provider, name}` objects (the canonical form the UI writes),
 * of `"provider:name"` strings, or a bare comma-separated string for hand-editing
 * convenience. An array that parses but yields no usable entry is MALFORMED, not empty —
 * `[{"provider":"claude"}]` is a botched restriction, not the absence of one.
 *
 * Implemented on `parseRoster` with the `allowed_profiles` source, which IS the #1025
 * migration: an existing allowlist value reads as an all-`pool` roster, at READ time, so
 * nothing stored ever has to be rewritten.
 */
export function parseProfileAllowlist(raw: string | null | undefined): ParsedProfileAllowlist {
  const roster = parseRoster(raw, "allowed_profiles");
  return {
    entries: roster.entries.map((e) => ({ provider: e.provider, name: e.name })),
    malformed: roster.malformed,
    restricted: roster.restricted,
  };
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

/** The all-`pool`, closed roster an allowlist denotes. */
export function allowlistAsRoster(allowlist: ParsedProfileAllowlist): ParsedRoster {
  return {
    entries: allowlist.entries.map((e) => ({ ...e, role: "pool" as const })),
    malformed: allowlist.malformed,
    restricted: allowlist.restricted,
    closed: true,
    source: "allowed_profiles",
  };
}

/**
 * Clamp a resolved provider/profile into the project's allowlist, skipping cooling
 * entries in declared order.
 *
 * Returns the selection to launch under, or a hold. Callers MUST check `holdReason`
 * before launching — an unchecked null `selection` would otherwise read as "no opinion"
 * and let the caller proceed on the unrestricted choice, which is the failure this whole
 * module exists to prevent.
 *
 * A projection of `resolveRosterSelection` since #1025. Nothing is lost by narrowing the
 * result here: the richer outcomes (a `forbidden` REFUSAL, a `reserve` start) cannot
 * arise from an all-`pool` roster, and a caller that needs them asks the roster resolver
 * directly rather than reading them out of a shape named "clamp".
 */
export function clampProfileToAllowlist(input: {
  allowlist: ParsedProfileAllowlist;
  provider: string | null | undefined;
  profileName: string | null | undefined;
  prefMap: Map<string, string>;
  nowMs: number;
}): ProfileClampResult {
  const result = resolveRosterSelection({
    roster: allowlistAsRoster(input.allowlist),
    provider: input.provider,
    profileName: input.profileName,
    prefMap: input.prefMap,
    nowMs: input.nowMs,
  });
  return {
    selection: result.selection ? { provider: result.selection.provider, name: result.selection.name } : null,
    clamped: result.clamped,
    holdReason: result.holdReason,
    note: result.note,
  };
}

const WORKER_CANNOT_ENFORCE =
  "and a fleet worker authenticates with its own machine-local login " +
  "(the board sends no credentials), so the restriction cannot be enforced there";

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
 * `rosterRaw` (#1025) asks the same question of the newer key: a project that expresses
 * its restriction as `roster_<projectId>` must not LOSE the #651 protection by migrating
 * onto the newer spelling. Either key blocks; both are read.
 *
 * Worker ATTESTATION (#1027) is what narrows this, and `attestation` is where it enters:
 * a worker that DECLARES the profile names it can authenticate as gives the board a fact
 * to act on without ever holding the credential, so "never" becomes "only to a worker that
 * attests". The block above is unchanged for everything else — no attestation, a worker
 * that attests only profiles this project forbids, an unreadable roster — because in every
 * one of those cases the board still cannot know which account the work would run under.
 */
export interface RemoteAttestationSummary {
  /** How many eligible workers attest a profile this project's roster PERMITS. */
  permittedWorkers: number;
  /** What was found, in the words the refusal appends. */
  detail?: string;
}

export function remoteDispatchBlockedByAllowlist(
  allowlistRaw: string | null | undefined,
  rosterRaw?: string | null | undefined,
  attestation?: RemoteAttestationSummary,
): { blocked: false } | { blocked: true; reason: string } {
  // The permissive direction, and the ONLY one an attestation can move: a restriction is
  // still a restriction, it is now satisfiable remotely. Deliberately asked BEFORE the
  // roster/allowlist are even parsed, so the answer cannot depend on which spelling the
  // project used.
  if (attestation && attestation.permittedWorkers > 0) return { blocked: false };
  const attestationTail = attestation?.detail ? ` — ${attestation.detail} (#1027)` : "";
  const roster = (rosterRaw ?? "").trim() ? parseRoster(rosterRaw, "roster") : null;
  if (roster?.restricted) {
    const detail = roster.malformed
      ? "its profile roster is present but unreadable"
      : `its roster is [${roster.entries.map((e) => `${profileRefId(e)} ${e.role}`).join(", ")}]`;
    return { blocked: true, reason: `${detail}, ${WORKER_CANNOT_ENFORCE}${attestationTail}` };
  }
  const allowlist = parseProfileAllowlist(allowlistRaw);
  if (!allowlist.restricted) return { blocked: false };
  const detail = allowlist.malformed
    ? "its profile allowlist is present but unreadable"
    : `it is restricted to [${allowlist.entries.map(allowedProfileId).join(", ")}]`;
  return { blocked: true, reason: `${detail}, ${WORKER_CANNOT_ENFORCE}${attestationTail}` };
}
