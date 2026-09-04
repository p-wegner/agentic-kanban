/**
 * The WRITE guard for `roster_<projectId>` (#1028).
 *
 * `resolveProjectRoster` already makes widening harmless at READ time — it combines the
 * project role with the observed global one through `mostRestrictiveRole`, so a project that
 * stores `pool` for a globally `forbidden` account still gets `forbidden`. That is the
 * design and it is not weakened here.
 *
 * This guard exists because "harmless" and "honest" are different properties. A stored value
 * that says `pool` where the effective role is `forbidden` is a preference file, a config
 * export and a Settings screen that all disagree with what the board will actually do — and
 * the next person to read it reasonably concludes the restriction was lifted. Rejecting the
 * write is what keeps the stored roster a true statement about the roster.
 *
 * It is a SECOND line, not the only one: the editor offers no widening role in the first
 * place. Both halves are wanted — the client one is the usable interface, this one is what
 * makes it true for a hand-written preference, a config import, or the CLI.
 */
import {
  mostRestrictiveRole,
  parseRoster,
  profileRefId,
  rosterPrefKey,
  type ProfileRole,
  type RosterEntry,
} from "@agentic-kanban/shared/lib/profile-allowlist";
import { loadObservedGlobalRoster } from "./profile-roster.service.js";

export interface RosterWideningViolation {
  key: string;
  profileId: string;
  /** The role the write asks for. */
  requested: ProfileRole;
  /** The role the ACCOUNT declares for itself — the floor the project may not rise above. */
  observed: ProfileRole;
}

/** One violation, phrased for the operator rather than for the log. */
export function describeRosterWideningViolation(v: RosterWideningViolation): string {
  return (
    `${v.profileId} is globally \`${v.observed}\` and this roster asks for \`${v.requested}\`. ` +
    `A project roster may only NARROW a profile's role (pool -> reserve -> forbidden), never widen it — ` +
    `the role belongs to the account, and only claude-pick changes it.`
  );
}

export interface RosterWideningCheckInput {
  /** The settings write, as submitted. Only `roster_<projectId>` keys are examined. */
  patch: Record<string, string>;
  /** The observed global roster. Omitted = read it (a test injects one). */
  globalRoster?: readonly RosterEntry[] | null;
  /** Ring values, when the caller already loaded the prefs. */
  claudeRingRaw?: string | null;
  codexRingRaw?: string | null;
}

/**
 * Every widening a settings patch would perform. Empty for every patch that touches no
 * roster key — which is all but a handful, so this is cheap on the common path (it does not
 * even read the rings until a roster key is present).
 *
 * A MALFORMED roster is not reported here. It is already handled where it matters: the
 * resolver fails closed and holds the launch, which is stricter than any widening, and
 * rejecting the write too would make an operator unable to store the value they are about to
 * fix.
 */
export function findRosterWidenings(input: RosterWideningCheckInput): RosterWideningViolation[] {
  const rosterKeys = Object.keys(input.patch).filter((key) => {
    // Derive the key SHAPE from the sanctioned builder rather than matching a literal — the
    // raw prefix must not appear outside the resolver (`roster-raw-read-ratchet`).
    const probe = rosterPrefKey("");
    return key.startsWith(probe) && key.length > probe.length;
  });
  if (rosterKeys.length === 0) return [];

  const observedRoles = new Map<string, ProfileRole>();
  const globals = input.globalRoster ?? loadObservedGlobalRoster({
    claudeRingRaw: input.claudeRingRaw,
    codexRingRaw: input.codexRingRaw,
  });
  for (const entry of globals) observedRoles.set(profileRefId(entry), entry.role);

  const violations: RosterWideningViolation[] = [];
  for (const key of rosterKeys) {
    const parsed = parseRoster(input.patch[key], "roster");
    if (parsed.malformed) continue;
    for (const entry of parsed.entries) {
      const id = profileRefId(entry);
      const observed = observedRoles.get(id) ?? "pool";
      // Widening is exactly "the combination is stricter than what was asked for".
      if (mostRestrictiveRole(entry.role, observed) !== entry.role) {
        violations.push({ key, profileId: id, requested: entry.role, observed });
      }
    }
  }
  return violations;
}
