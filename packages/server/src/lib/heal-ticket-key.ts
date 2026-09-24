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

/** The `external_key` of a project's heal ticket for one failure signature. */
export function healTicketExternalKey(projectId: string, signature: string): string {
  return `${healTicketKeyPrefix(projectId)}${signature}`;
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

/**
 * Inverse of {@link healTicketExternalKey}: null for anything that is not a heal key. A key
 * from before #1233 (`base-health-heal:<projectId>`, no signature) parses with `signature:
 * null`, so the prefix scan and the green-close path still reach it.
 */
export function parseHealTicketExternalKey(
  externalKey: string | null | undefined,
): { projectId: string; signature: string | null } | null {
  if (!externalKey || !externalKey.startsWith(HEAL_TICKET_KEY_PREFIX)) return null;
  const rest = externalKey.slice(HEAL_TICKET_KEY_PREFIX.length);
  if (!rest) return null;
  const sep = rest.indexOf(":");
  if (sep === -1) return { projectId: rest, signature: null };
  const projectId = rest.slice(0, sep);
  const signature = rest.slice(sep + 1);
  return projectId ? { projectId, signature: signature || null } : null;
}
