/**
 * The pure half of the roster UI (#1028) — the narrowing rule as the editor applies it, and
 * the labels the table renders. Paired with `components/settings/ProfileRosterTable.tsx` and
 * `ProjectRosterEditor.tsx` per the client's `lib/<feature>.ts` convention (#589).
 *
 * The narrowing rule is NOT restated here. `mostRestrictiveRole` from shared is the rule;
 * these functions are phrased as questions asked OF it, so the editor cannot come to a
 * different conclusion than the resolver about what a project may set. A client-side copy of
 * the ladder is exactly the drift the roster's "one place applies the rule" design forbids.
 *
 * Rejection is expressed as a value, not a thrown error: a widening attempt is a normal
 * thing for a UI to receive (a stale page, a role changed with claude-pick a minute ago) and
 * the caller has to be able to say WHY it refused.
 */
import { PROFILE_ROLES, mostRestrictiveRole, type ProfileRole } from "@agentic-kanban/shared/lib/profile-allowlist";
import type { AgentProviderName } from "@agentic-kanban/shared/lib/provider-traits";
import type { ProfileRosterProfile } from "@agentic-kanban/shared/types";

/**
 * True when setting `requested` for a profile whose account declares `globalRole` would
 * WIDEN it — i.e. the combination the resolver would compute is stricter than the request,
 * so the stored value would not be what actually happens.
 */
export function isRoleWidening(requested: ProfileRole, globalRole: ProfileRole): boolean {
  return mostRestrictiveRole(requested, globalRole) !== requested;
}

/** The roles a project may set for a profile — the observed role and everything below it. */
export function allowedRolesFor(globalRole: ProfileRole): ProfileRole[] {
  return PROFILE_ROLES.filter((role) => !isRoleWidening(role, globalRole));
}

/** Why a widening was refused, in the words an operator needs to act on it. */
export function wideningRejectionMessage(
  profileId: string,
  requested: ProfileRole,
  globalRole: ProfileRole,
): string {
  return (
    `${profileId} is globally "${globalRole}" — a project roster can only narrow a role, never widen it. ` +
    `Change the account's own role with claude-pick if that is what you mean.`
  );
}

export interface RosterDraftEntry {
  provider: AgentProviderName;
  name: string;
  role: ProfileRole;
}

export interface RoleChangeResult {
  entries: RosterDraftEntry[];
  /** Null when the change was applied; the reason when it was refused. */
  rejected: string | null;
}

/**
 * Set one profile's role in a draft roster, refusing a widening.
 *
 * A role of `pool` on a profile the project has never listed still ADDS it — the project
 * roster is CLOSED, so listing a profile as `pool` is the only way to say "this project may
 * use this account", and treating `pool` as "remove" would make that unsayable.
 */
export function applyRoleChange(
  entries: readonly RosterDraftEntry[],
  profile: { provider: AgentProviderName; name: string; id: string },
  requested: ProfileRole,
  globalRole: ProfileRole,
): RoleChangeResult {
  if (isRoleWidening(requested, globalRole)) {
    return { entries: [...entries], rejected: wideningRejectionMessage(profile.id, requested, globalRole) };
  }
  const idx = entries.findIndex((e) => `${e.provider}:${e.name}` === profile.id);
  const next = [...entries];
  if (idx === -1) next.push({ provider: profile.provider, name: profile.name, role: requested });
  else next[idx] = { ...next[idx], role: requested };
  return { entries: next, rejected: null };
}

/** Remove a profile from the draft roster entirely (i.e. this project may not use it). */
export function removeFromRoster(entries: readonly RosterDraftEntry[], profileId: string): RosterDraftEntry[] {
  return entries.filter((e) => `${e.provider}:${e.name}` !== profileId);
}

/**
 * The 5-hour/7-day reading as a cell. `unknown` renders as an explicit word, never as `0%`
 * or a blank: the #1023 distinction is that an unmeasured window is neither exhausted nor
 * empty, and a dash the reader mistakes for "nothing used" is the failure this label exists
 * to prevent.
 */
export function headroomLabel(percentUsed: number | null, stale: boolean): string {
  if (stale) return "unknown";
  if (percentUsed == null) return "—";
  return `${Math.round(percentUsed)}%`;
}

/** Age is the trust signal, so "never measured" says so rather than showing nothing. */
export function measurementAgeLabel(ageSeconds: number | null): string {
  if (ageSeconds == null) return "never";
  if (ageSeconds < 60) return `${Math.round(ageSeconds)}s ago`;
  if (ageSeconds < 3600) return `${Math.round(ageSeconds / 60)}m ago`;
  return `${Math.round(ageSeconds / 3600)}h ago`;
}

/** The reset instant as a clock time, or an em dash. Locale-explicit (client CLAUDE.md). */
export function resetLabel(resetIso: string | null): string {
  if (!resetIso) return "—";
  const at = new Date(resetIso);
  if (Number.isNaN(at.getTime())) return "—";
  return at.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

/** How long a cooling profile stays out, or "—" when it is not cooling. */
export function cooldownLabel(coolingUntilIso: string | null, nowMs: number): string {
  if (!coolingUntilIso) return "—";
  const until = Date.parse(coolingUntilIso);
  if (Number.isNaN(until)) return "—";
  const remainingMs = until - nowMs;
  if (remainingMs <= 0) return "—";
  const minutes = Math.ceil(remainingMs / 60_000);
  return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

/** Tailwind classes per role, so the three roles read differently at a glance. */
export function roleBadgeClasses(role: ProfileRole): string {
  if (role === "forbidden") return "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300";
  if (role === "reserve") return "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300";
  return "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300";
}

/**
 * The profiles worth warning about in the Monitor view: a role two machines disagree about.
 * A conflict is resolved (the more restrictive role wins), so it never blocks anything — and
 * that is precisely why it needs surfacing, or it stays invisible until someone wonders why
 * an account they set to `pool` is being treated as `forbidden`.
 */
export function conflictingProfiles(profiles: readonly ProfileRosterProfile[]): ProfileRosterProfile[] {
  return profiles.filter((p) => p.roleConflict || p.roleWarnings.length > 0);
}
