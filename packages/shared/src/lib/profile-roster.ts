/**
 * The profile ROSTER — the per-project allowlist grown a role dimension (#1025,
 * proposal `docs/proposals/2026-09-03-dev-board-vs-deployed-board.md` §6 "Zielmodell:
 * der Profilkader").
 *
 * ## What a roster is, and what it is not
 *
 * `allowed_profiles_<projectId>` is a flat list: every entry is equally usable, tried in
 * declared order, and anything absent is refused. That cannot say "this account is the
 * emergency reserve", it cannot say "this account must never see this work" (an absent
 * name is only refused for projects that HAVE a list at all), and it cannot say "prefer
 * whichever of these has quota left". A roster says all three:
 *
 * | role | meaning | selection |
 * |---|---|---|
 * | `pool` | ordinary supply | ordered by REMAINING 5-hour headroom, not list order; at or over the threshold it counts as exhausted |
 * | `reserve` | emergency | only when every pool profile is exhausted or cooling AND reserve is allowed; every such start is logged |
 * | `forbidden` | never | REFUSED, not clamped — an explicit workspace choice, a ring rewrite and a CLI `--profile` all get a refusal |
 *
 * ## Two rosters, and the narrowing rule
 *
 * The GLOBAL roster is not a preference: it is what profile discovery OBSERVED
 * (`profile-attributes.ts`, #1024) — the role each account declares for itself, default
 * `pool`. The per-project `roster_<projectId>` preference may only ever NARROW it
 * (`pool` → `reserve`/`forbidden`), never widen, which is what makes a global
 * `forbidden` unliftable BY CONSTRUCTION rather than by a rule someone must remember.
 *
 * ## Open vs closed
 *
 * A project WITHOUT its own roster gets an OPEN roster: the observed roles bite (a
 * globally forbidden profile is refused everywhere) but a profile nobody has an opinion
 * about is ordinary supply, so a board with no non-pool profiles anywhere behaves
 * EXACTLY as it did before this file existed. A project WITH its own roster gets a
 * CLOSED one: it sees only the profiles named there, and exhaustion HOLDS — today's
 * allowlist semantics, unchanged, including the #651 remote refusal.
 *
 * PURE and client-safe (no node builtins): the Settings UI must be able to preview the
 * same decision the server will make. The ROLE-observing half is the node-only
 * `profile-attributes.ts`, which imports its role vocabulary from here so the two
 * cannot drift.
 */
import type { AgentProviderName } from "./provider-traits.js";
import { narrowProvider } from "./provider-traits.js";
import { projectPref } from "./dynamic-preference-keys.js";

export const PROFILE_ROLES = ["pool", "reserve", "forbidden"] as const;
export type ProfileRole = (typeof PROFILE_ROLES)[number];

/** No declaration anywhere → the account is ordinary supply. */
export const DEFAULT_PROFILE_ROLE: ProfileRole = "pool";

/** Percent of the 5-hour window at or above which a pool profile counts as exhausted. */
export const DEFAULT_POOL_EXHAUSTED_PCT = 90;

/** The ticket tag that permits one ticket to reach for the reserve. */
export const RESERVE_OK_TAG = "reserve:ok";

const rosterPrefDef = projectPref("roster");
const reserveAllowedPrefDef = projectPref("reserve_allowed");
const rosterExhaustedPctPrefDef = projectPref("roster_exhausted_pct");

/** `roster_<projectId>` — the per-project NARROWING of the observed global roster. */
export function rosterPrefKey(projectId: string): string {
  return rosterPrefDef.key(projectId);
}

/** `reserve_allowed_<projectId>` — may this project reach for a `reserve` profile at all? */
export function reserveAllowedPrefKey(projectId: string): string {
  return reserveAllowedPrefDef.key(projectId);
}

/** `roster_exhausted_pct_<projectId>` — the pool exhaustion threshold, default 90. */
export function rosterExhaustedPctPrefKey(projectId: string): string {
  return rosterExhaustedPctPrefDef.key(projectId);
}

/** One `{provider, name}` pair — the identity everything here is keyed by. */
export interface ProfileRef {
  provider: AgentProviderName;
  name: string;
}

/** A rostered profile: a ref plus the role it carries FOR THIS PROJECT. */
export interface RosterEntry extends ProfileRef {
  role: ProfileRole;
  /**
   * `KANBAN_PROFILE_DEDICATED` — "forbidden everywhere except this project slug".
   * Carried on the GLOBAL entry; `resolveProjectRoster` turns it into a `forbidden`
   * role for every other project.
   */
  dedicatedProject?: string | null;
}

/**
 * A parsed roster. `entries` is empty for BOTH "no restriction" and "restricted to
 * nothing", which must not be confused — `malformed` is what separates them.
 */
export interface ParsedRoster {
  entries: RosterEntry[];
  /** The stored value was present but could not be understood at all. */
  malformed: boolean;
  /** A restriction is in force (roles that bite, a project roster, or a malformed one). */
  restricted: boolean;
  /**
   * True when ONLY the listed profiles may be used (a per-project roster, or a legacy
   * allowlist). False for the observed global roster alone, where an unlisted profile is
   * ordinary supply — that is what keeps a board with no declared roles byte-for-byte
   * unchanged.
   */
  closed: boolean;
  /** Which stored value this came from — decides the wording of notes and holds. */
  source: "none" | "allowed_profiles" | "roster";
}

export function isProfileRole(value: unknown): value is ProfileRole {
  return typeof value === "string" && (PROFILE_ROLES as readonly string[]).includes(value);
}

/**
 * The more restrictive of two roles (`forbidden` > `reserve` > `pool`).
 *
 * This is the narrowing rule in one function: a per-project role is combined with the
 * observed global role through it, so a project can only ever move a profile DOWN the
 * ladder. It is also the rule two disagreeing carriers resolve a conflict by
 * (`mergeProfileObservations`).
 */
export function mostRestrictiveRole(a: ProfileRole, b: ProfileRole): ProfileRole {
  if (a === "forbidden" || b === "forbidden") return "forbidden";
  if (a === "reserve" || b === "reserve") return "reserve";
  return "pool";
}

/** `provider:name`, the stable identity used for dedupe and comparison. */
export function profileRefId(entry: ProfileRef): string {
  return `${entry.provider}:${entry.name}`;
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
  entry: ProfileRef,
  prefMap: Map<string, string>,
  nowMs: number,
): boolean {
  const stamp = prefMap.get(profileCooldownKey(entry.provider, entry.name));
  if (!stamp) return false;
  const until = Date.parse(stamp);
  if (Number.isNaN(until)) return false;
  return until > nowMs;
}

/**
 * Normalize one stored entry into a ref plus a role.
 *
 * Accepted forms — the compact `"claude:anth"` (matching a Bullseye policy id), the same
 * with a role appended (`"claude:anth:reserve"`), a bare name (which means claude, the
 * board's own default provider), and the canonical object form `{provider, name, role}`.
 * A bare name is re-TAGGED rather than guessed away, and an unknown provider is narrowed
 * rather than dropped: silently shrinking a roster can only make it more restrictive
 * than the operator wrote, which at zero entries becomes a hold.
 */
function normalizeRosterEntry(value: unknown): RosterEntry | null {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    const parts = text.split(":").map((p) => p.trim());
    const role = parts.length >= 3 && isProfileRole(parts[parts.length - 1])
      ? (parts.pop() as ProfileRole)
      : DEFAULT_PROFILE_ROLE;
    if (parts.length === 1) {
      return parts[0] ? { provider: "claude", name: parts[0], role } : null;
    }
    const name = parts.slice(1).join(":");
    if (!name) return null;
    return { provider: narrowProvider(parts[0]), name, role };
  }
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const rawName = typeof rec.name === "string" ? rec.name : typeof rec.profileName === "string" ? rec.profileName : "";
    const name = rawName.trim();
    if (!name) return null;
    const role = isProfileRole(rec.role) ? rec.role : DEFAULT_PROFILE_ROLE;
    const dedicated = typeof rec.dedicatedProject === "string" && rec.dedicatedProject.trim()
      ? rec.dedicatedProject.trim()
      : null;
    return {
      provider: narrowProvider(typeof rec.provider === "string" ? rec.provider : undefined),
      name,
      role,
      dedicatedProject: dedicated,
    };
  }
  return null;
}

/**
 * Parse a stored roster value (`roster_<projectId>`, or a legacy
 * `allowed_profiles_<projectId>` whose entries all read as `pool` — that IS the
 * migration path, and it is a READ-time one, so no stored value has to be rewritten).
 *
 * Fails CLOSED: a value that is present but yields no usable entry is MALFORMED, not
 * empty. A kill-switch that fails open is not a kill-switch.
 */
export function parseRoster(
  raw: string | null | undefined,
  source: "allowed_profiles" | "roster" = "roster",
): ParsedRoster {
  const empty: ParsedRoster = { entries: [], malformed: false, restricted: false, closed: false, source: "none" };
  const text = (raw ?? "").trim();
  if (!text) return empty;

  let list: unknown[] | null = null;
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      list = Array.isArray(parsed) ? parsed : null;
    } catch {
      list = null;
    }
  } else {
    // Not JSON — a comma-separated list of compact ids, for hand-editing.
    list = text.split(",");
  }
  if (!list) return { entries: [], malformed: true, restricted: true, closed: true, source };
  // An explicit empty array is the one way to say "restriction removed" without deleting
  // the row, so it is empty-and-well-formed rather than malformed.
  if (list.length === 0) return empty;

  const entries: RosterEntry[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const entry = normalizeRosterEntry(item);
    if (!entry) continue;
    const id = profileRefId(entry);
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push(entry);
  }
  if (entries.length === 0) return { entries: [], malformed: true, restricted: true, closed: true, source };
  return { entries, malformed: false, restricted: true, closed: true, source };
}

/** Serialize back to the canonical stored form. */
export function serializeRoster(entries: RosterEntry[]): string {
  return JSON.stringify(entries.map((e) => ({ provider: e.provider, name: e.name, role: e.role })));
}

export interface ResolveProjectRosterInput {
  /** What discovery OBSERVED (#1024): every known profile with the role it declares. */
  globalRoster?: readonly RosterEntry[] | null;
  /** The `roster_<projectId>` value. */
  rosterRaw?: string | null;
  /** The legacy `allowed_profiles_<projectId>` value — read as an all-`pool` roster. */
  allowlistRaw?: string | null;
  /** This project's slug, for `KANBAN_PROFILE_DEDICATED` ("forbidden except here"). */
  projectSlug?: string | null;
}

/**
 * Combine the observed global roster with the project's own, applying the narrowing
 * rule. The project roster may only move a profile DOWN the role ladder; a global
 * `forbidden` survives every per-project value, and a `dedicated` profile is forbidden
 * for every project but the one it names.
 *
 * A project roster wins over a legacy allowlist when both exist: the allowlist is the
 * older spelling of the same intent, and reading both would make an operator's migration
 * silently additive.
 */
export function resolveProjectRoster(input: ResolveProjectRosterInput): ParsedRoster {
  const slug = input.projectSlug?.trim() || null;
  const globals = new Map<string, RosterEntry>();
  for (const entry of input.globalRoster ?? []) {
    const dedicated = entry.dedicatedProject?.trim() || null;
    const role = dedicated && dedicated !== slug ? "forbidden" : entry.role;
    globals.set(profileRefId(entry), { ...entry, role });
  }

  const own = (input.rosterRaw ?? "").trim()
    ? parseRoster(input.rosterRaw, "roster")
    : parseRoster(input.allowlistRaw, "allowed_profiles");

  if (own.malformed) return own;

  if (own.restricted) {
    const entries = own.entries.map((e) => {
      const global = globals.get(profileRefId(e));
      return { ...e, role: mostRestrictiveRole(e.role, global?.role ?? DEFAULT_PROFILE_ROLE) };
    });
    return { ...own, entries };
  }

  // No project roster: the observed roles alone. They only constitute a restriction when
  // at least one of them is not `pool` — otherwise this is the historic unrestricted case
  // and must stay indistinguishable from it.
  const entries = [...globals.values()];
  const restricted = entries.some((e) => e.role !== DEFAULT_PROFILE_ROLE);
  return { entries, malformed: false, restricted, closed: false, source: "none" };
}

/**
 * Is this project permitted to reach for a `reserve` profile?
 *
 * Three independent grants, any of which suffices (proposal §6): the project flag, a
 * ticket tag, or a human explicitly starting the work. The tag is per-ticket on purpose —
 * "this one job may burn the emergency account" is a property of the job, not of the
 * project.
 */
export function resolveReserveAllowance(input: {
  prefMap: Map<string, string>;
  projectId: string;
  issueTags?: readonly string[] | null;
  operatorStart?: boolean;
}): { allowed: boolean; reason: string | null } {
  if (input.operatorStart) return { allowed: true, reason: "explicit operator start" };
  const key = reserveAllowedPrefKey(input.projectId);
  if (input.prefMap.get(key)?.trim().toLowerCase() === "true") return { allowed: true, reason: `${key}=true` };
  const tagged = (input.issueTags ?? []).some((t) => t.trim().toLowerCase() === RESERVE_OK_TAG);
  if (tagged) return { allowed: true, reason: `ticket tag ${RESERVE_OK_TAG}` };
  return { allowed: false, reason: null };
}

/**
 * The pool-exhaustion threshold for a project, in percent of the 5-hour window.
 * An unparseable or out-of-range value falls back to the default rather than throwing —
 * a typo must not take every launch down, and the default is the safe reading.
 */
export function resolvePoolExhaustedPct(prefMap: Map<string, string>, projectId: string): number {
  const parsed = Number.parseFloat((prefMap.get(rosterExhaustedPctPrefKey(projectId)) ?? "").trim());
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) return DEFAULT_POOL_EXHAUSTED_PCT;
  return parsed;
}
