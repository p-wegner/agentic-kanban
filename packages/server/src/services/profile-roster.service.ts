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
import type { RosterEntry } from "@agentic-kanban/shared/lib/profile-allowlist";

/** How long an observation is reused before the carriers are read again. */
export const ROSTER_CACHE_TTL_MS = 5_000;

let cache: { entries: RosterEntry[]; atMs: number } | null = null;

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
  const nowMs = input.nowMs ?? Date.now();
  if (!input.force && cache && nowMs - cache.atMs < ROSTER_CACHE_TTL_MS) return cache.entries;

  const entries: RosterEntry[] = [];
  for (const sub of listClaudeSubscriptions(parseClaudeSubscriptionRing(input.claudeRingRaw ?? null))) {
    entries.push({
      provider: "claude",
      name: sub.profile,
      role: sub.role,
      dedicatedProject: sub.dedicatedProject,
    });
  }
  for (const license of listCodexLicenses(parseCodexLicenseRing(input.codexRingRaw ?? null))) {
    entries.push({
      provider: "codex",
      name: license.profile,
      role: license.role,
      dedicatedProject: license.dedicatedProject,
    });
  }
  cache = { entries, atMs: nowMs };
  return entries;
}

/** Drop the cache — for tests and for an explicit "re-read the profiles" action. */
export function resetObservedGlobalRosterCache(): void {
  cache = null;
}
