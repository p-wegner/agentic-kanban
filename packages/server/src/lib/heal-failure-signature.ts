/**
 * The FAILURE SIGNATURE of a base-health sweep (#1233) — the identity one heal ticket stands
 * for, so a project files one ticket per DISTINCT failing set rather than one per project.
 *
 * Why a signature and not the project: with one ticket per project (#1016) a second red sweep
 * with a different failing set REWROTE the open ticket's body, so a builder mid-diagnosis had
 * its list swapped under it and the first red's history was gone. Keying on the failing set
 * keeps each ticket about one thing; a red that changes shape files a second ticket beside the
 * first, and a green closes them all.
 *
 * The signature is a short hash of the SORTED, de-duplicated, slash-normalised suite list —
 * order and duplicates in the sweep's report must not read as a new failure, and a Windows
 * path and its POSIX spelling must not either. A sweep that named no suite at all (verify
 * failed before or outside the suite list) gets the constant {@link VERIFY_FAILED_SIGNATURE},
 * which is deliberately NOT derived from the output tail: that tail carries timings and
 * process ids, so hashing it would make every such sweep a fresh signature.
 *
 * `server/lib`, not `shared/lib`: the heal-ticket service and its test are the only consumers
 * (#590/#730, `shared-lib-single-consumer-ratchet.test.ts`).
 */
import { createHash } from "node:crypto";

/** The signature of a red sweep that could not name a single failing suite. */
export const VERIFY_FAILED_SIGNATURE = "verify-failed";

/** How many hex characters of the digest make up a signature — enough to never collide within one project. */
const SIGNATURE_LENGTH = 12;

/** The canonical suite list a signature is computed over: trimmed, POSIX slashes, unique, sorted. */
export function canonicalFailedSuites(failedSuites: readonly string[] | null | undefined): string[] {
  const seen = new Set<string>();
  for (const raw of failedSuites ?? []) {
    const suite = raw.trim().replace(/\\/g, "/");
    if (suite) seen.add(suite);
  }
  return [...seen].sort();
}

/** The failure signature of one sweep verdict — see the header. */
export function failureSignature(failedSuites: readonly string[] | null | undefined): string {
  const suites = canonicalFailedSuites(failedSuites);
  if (suites.length === 0) return VERIFY_FAILED_SIGNATURE;
  return createHash("sha1").update(suites.join("\n")).digest("hex").slice(0, SIGNATURE_LENGTH);
}
