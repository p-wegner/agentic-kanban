/**
 * Identity of the base-health **heal ticket** (#1016).
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
 * The key is CONSTANT per project, not per sweep or per sha. The invariant is "at most one OPEN
 * heal ticket per project": a closed heal ticket keeps its key, and a later red episode files a
 * new ticket with the same key, so a project accumulates a legible history of heal episodes
 * while only ever one of them is open. Lookups therefore filter by status, never by key alone.
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

/** The `external_key` of a project's heal ticket. */
export function healTicketExternalKey(projectId: string): string {
  return `${HEAL_TICKET_KEY_PREFIX}${projectId}`;
}

/** Inverse of {@link healTicketExternalKey}: null for anything that is not a heal key. */
export function parseHealTicketExternalKey(
  externalKey: string | null | undefined,
): { projectId: string } | null {
  if (!externalKey || !externalKey.startsWith(HEAL_TICKET_KEY_PREFIX)) return null;
  const projectId = externalKey.slice(HEAL_TICKET_KEY_PREFIX.length);
  return projectId ? { projectId } : null;
}
