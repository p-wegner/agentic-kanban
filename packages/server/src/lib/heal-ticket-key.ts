/**
 * Identity of the base-health **heal ticket** (#1016, per failure signature since #1233).
 *
 * Under land-then-heal (proposal `2026-09-03-dev-board-vs-deployed-board.md` §3.B) a project
 * whose effective `redBasePolicy` is `allow-file-debt-ticket` does not block merges on a red
 * base — the nightly full-suite sweep files ONE ticket carrying the failing-suite list, which a
 * single agent diagnoses, instead of N per-branch gates re-running the same suites.
 *
 * "ONE ticket" needs an identity the next sweep can find, and it must not be the TITLE: a title
 * carries the failing suites and therefore changes on every sweep. So the key rides on
 * `issues.external_key`, exactly as the plugin-loop unit key does (`plugin-keys.ts`), and with
 * the same KNOWN DEBT (#201): that column is documented and rendered as a genuine
 * external-tracker link, not a board-internal dedupe carrier. It works here for the same two
 * reasons it works there — the value is namespace-prefixed, and a heal ticket never sets
 * `external_url`. This is the second such feature, which is the trigger #201 named for giving
 * the identity its own nullable `source_key` column; that migration is deliberately NOT done
 * inside this ticket, and both call sites should move together when it is.
 *
 * The key is per project AND per FAILURE SIGNATURE (#1233): `base-health-heal:<projectId>:<sig>`,
 * where `sig` is `failureSignature(failedSuites)` (`heal-failure-signature.ts`). The invariant is
 * "at most one OPEN heal ticket per signature": a second red sweep with the same failing set
 * refreshes that ticket rather than filing another, a red with a NEW set files a second ticket
 * beside it, and a green sweep closes every open one. A closed heal ticket keeps its key, so a
 * later red episode with the same signature files a new ticket under the same key and a project
 * accumulates a legible history of episodes. Lookups therefore filter by status, never by key
 * alone — and by the PREFIX `base-health-heal:<projectId>` (`healTicketKeyScanPrefix`) when
 * they mean "every heal ticket of this project". A pre-#1233 key without a signature segment
 * still parses (its signature is `null`) and still matches that scan prefix, so an older open
 * ticket is found and closed by the next green.
 *
 * Pure strings, no Node builtins. It lives in `packages/server/src/lib` and NOT in
 * `packages/shared/src/lib` because `server` is its only consuming package (the sweep service
 * and its test) — `shared/lib` is for code MORE THAN ONE package needs (#590/#730), enforced by
 * `shared-lib-single-consumer-ratchet.test.ts`. Move it to `shared` only when a second package
 * actually imports it.
 */

/** Namespace prefix, so a heal key can never collide with a real tracker id or a loop key. */
export const HEAL_TICKET_KEY_PREFIX = "base-health-heal:";

/** The tag every heal ticket carries, so the board can list them without parsing keys. */
export const HEAL_TICKET_TAG = "heal";

/**
 * The `external_key` of a project's heal ticket for one failure signature — and, since #1239,
 * for one RELEASE CANDIDATE: `base-health-heal:<projectId>:<sig>:<rcBranch>`. The branch
 * segment is what makes "at most one open heal ticket per signature" hold PER rc: the same
 * failing set on `rc/20260925` and on `rc/20260926` are two tickets, because they are healed
 * on two different trees and merged back separately. A base-lane key carries no branch.
 */
export function healTicketExternalKey(projectId: string, signature: string, branch?: string | null): string {
  return `${healTicketKeyPrefix(projectId)}${signature}${branch ? `:${branch}` : ""}`;
}

/** The prefix every signature-scoped heal key of one project is built from. */
export function healTicketKeyPrefix(projectId: string): string {
  return `${HEAL_TICKET_KEY_PREFIX}${projectId}:`;
}

/**
 * What "every heal ticket of this project" scans by: no trailing `:`, so a pre-#1233 key
 * (`base-health-heal:<projectId>`) matches too. Callers must still confirm each hit with
 * {@link parseHealTicketExternalKey} — a LIKE prefix is not an exact project match on its own.
 */
export function healTicketKeyScanPrefix(projectId: string): string {
  return `${HEAL_TICKET_KEY_PREFIX}${projectId}`;
}

export interface ParsedHealTicketKey {
  projectId: string;
  signature: string | null;
  /** The release candidate the ticket heals ON (#1239); `null` for a base-lane ticket. */
  branch: string | null;
}

/**
 * Inverse of {@link healTicketExternalKey}: null for anything that is not a heal key. A key
 * from before #1233 (`base-health-heal:<projectId>`, no signature) parses with `signature:
 * null`, so the prefix scan and the green-close path still reach it. A signature is a hex
 * digest or the `verify-failed` constant, so the FIRST `:` after it starts the branch (#1239);
 * an rc branch (`rc/<date>[-N]`) never contains one.
 */
export function parseHealTicketExternalKey(
  externalKey: string | null | undefined,
): ParsedHealTicketKey | null {
  if (!externalKey || !externalKey.startsWith(HEAL_TICKET_KEY_PREFIX)) return null;
  const rest = externalKey.slice(HEAL_TICKET_KEY_PREFIX.length);
  if (!rest) return null;
  const sep = rest.indexOf(":");
  if (sep === -1) return { projectId: rest, signature: null, branch: null };
  const projectId = rest.slice(0, sep);
  const tail = rest.slice(sep + 1);
  const branchSep = tail.indexOf(":");
  const signature = branchSep === -1 ? tail : tail.slice(0, branchSep);
  const branch = branchSep === -1 ? null : tail.slice(branchSep + 1);
  return projectId ? { projectId, signature: signature || null, branch: branch || null } : null;
}

// --- the merge-back ticket (#1239 item 3) ------------------------------------------------------

/** Namespace prefix of the ticket whose workspace merges a promoted rc back into master. */
export const MERGE_BACK_KEY_PREFIX = "rc-merge-back:";

/** `rc-merge-back:<projectId>:<rcBranch>` — one per candidate, found by key like a heal ticket. */
export function mergeBackExternalKey(projectId: string, rcBranch: string): string {
  return `${MERGE_BACK_KEY_PREFIX}${projectId}:${rcBranch}`;
}

/** Inverse of {@link mergeBackExternalKey}; null for anything else. */
export function parseMergeBackExternalKey(
  externalKey: string | null | undefined,
): { projectId: string; branch: string } | null {
  if (!externalKey || !externalKey.startsWith(MERGE_BACK_KEY_PREFIX)) return null;
  const rest = externalKey.slice(MERGE_BACK_KEY_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep === -1) return null;
  const projectId = rest.slice(0, sep);
  const branch = rest.slice(sep + 1);
  return projectId && branch ? { projectId, branch } : null;
}
