/**
 * The OBSERVED global roster (#1025): every profile the board knows about, carrying the
 * role that profile declares for ITSELF.
 *
 * The board does not own these roles and must never write them — a role is a property of
 * the ACCOUNT ("this subscription belongs to customer X", "this one is the private
 * emergency reserve"), true on every machine the login exists on, and claude-pick owns its
 * lifecycle (proposal §6, "claude-pick besitzt den Lebenszyklus der Attribute"). A board
 * that could change a role would be a second source of truth, which is exactly what
 * decision 017 and the `set-provider-default` rule abolished elsewhere.
 *
 * So this is a projection, not a store: the two rotation rings already READ each profile's
 * carrier during discovery (#1024) and expose `role`/`dedicatedProject` on their info
 * rows; this turns those rows into the vocabulary `resolveProjectRoster` narrows.
 *
 * It is cached for a few seconds because the source is a filesystem walk over every
 * `~/.claude-*` / `~/.codex-*` directory, and a workspace launch, a launch PREVIEW and a
 * monitor cycle can ask within the same second. The TTL is short on purpose: a role a
 * human just changed with claude-pick should take effect without restarting the board.
 */
import {
  listClaudeSubscriptions,
  parseClaudeSubscriptionRing,
} from "./claude-subscription-ring.js";
import { listCodexLicenses, parseCodexLicenseRing } from "./codex-license-ring.js";
import type { ProfileRole, RosterEntry } from "@agentic-kanban/shared/lib/profile-allowlist";

/** How long an observation is reused before the carriers are read again. */
export const ROSTER_CACHE_TTL_MS = 5_000;

/**
 * A roster entry plus everything discovery ALSO saw about the profile (#1028).
 *
 * The selection path needs only `{provider, name, role, dedicatedProject}`, which is why
 * `loadObservedGlobalRoster` returns exactly that. A roster TABLE needs the rest — whether
 * the account is logged in, whether two machines disagreed about its role, when that role
 * was observed — and reading the rings a second time in a route to get it would make the
 * table and the resolver two different observations of the same disk. So the richer row is
 * what the walk produces and the narrow one is a projection of it.
 *
 * This EXPOSES what #1025 already read; it decides nothing.
 */
export interface ObservedRosterRow extends RosterEntry {
  loggedIn: boolean;
  inRing: boolean;
  roleObservedAt: string | null;
  roleConflict: boolean;
  conflictingRoles: ProfileRole[];
  roleWarnings: string[];
}

let cache: { entries: ObservedRosterRow[]; atMs: number } | null = null;

export interface ObservedRosterInput {
  /** The stored `claude_subscription_ring` value, if the caller already has it. */
  claudeRingRaw?: string | null;
  /** The stored `codex_license_ring` value, if the caller already has it. */
  codexRingRaw?: string | null;
  /** Bypass the TTL cache (a test, or a deliberate refresh). */
  force?: boolean;
  /** Injected clock (`nowMs` spelling, #614). */
  nowMs?: number;
}

/**
 * Every known profile with its observed role. A profile that declares nothing is `pool`,
 * so a board where nobody has ever set `KANBAN_PROFILE_ROLE` gets an all-`pool` roster —
 * which `resolveProjectRoster` reports as UNRESTRICTED, i.e. today's behaviour exactly.
 */
export function loadObservedGlobalRoster(input: ObservedRosterInput = {}): RosterEntry[] {
  return loadObservedRosterDetails(input);
}

/**
 * The same observation, with the fields a roster TABLE renders (#1028). Same cache, same
 * TTL, same walk — `loadObservedGlobalRoster` is the narrow projection of this.
 */
export function loadObservedRosterDetails(input: ObservedRosterInput = {}): ObservedRosterRow[] {
  const nowMs = input.nowMs ?? Date.now();
  if (!input.force && cache && nowMs - cache.atMs < ROSTER_CACHE_TTL_MS) return cache.entries;

  const entries: ObservedRosterRow[] = [];
  for (const sub of listClaudeSubscriptions(parseClaudeSubscriptionRing(input.claudeRingRaw ?? null))) {
    entries.push({
      provider: "claude",
      name: sub.profile,
      role: sub.role,
      dedicatedProject: sub.dedicatedProject,
      loggedIn: sub.loggedIn,
      inRing: sub.inRing,
      roleObservedAt: sub.roleObservedAt,
      roleConflict: sub.roleConflict,
      conflictingRoles: sub.conflictingRoles,
      roleWarnings: sub.roleWarnings,
    });
  }
  for (const license of listCodexLicenses(parseCodexLicenseRing(input.codexRingRaw ?? null))) {
    entries.push({
      provider: "codex",
      name: license.profile,
      role: license.role,
      dedicatedProject: license.dedicatedProject,
      loggedIn: license.loggedIn,
      inRing: license.inRing,
      roleObservedAt: license.roleObservedAt,
      roleConflict: license.roleConflict,
      conflictingRoles: license.conflictingRoles,
      roleWarnings: license.roleWarnings,
    });
  }
  cache = { entries, atMs: nowMs };
  return entries;
}

/** Drop the cache — for tests and for an explicit "re-read the profiles" action. */
export function resetObservedGlobalRosterCache(): void {
  cache = null;
}
