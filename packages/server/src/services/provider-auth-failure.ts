/**
 * Detection of an UNRECOVERABLE provider auth failure — a login that will never
 * succeed again on its own, as opposed to a quota limit that resets on a timer.
 *
 * Why this exists (#430): a `mealplan` PM Pipeline run had one workspace burn 10
 * sessions in 91 seconds, all on the SAME profile, all dying with
 *
 *   Failed to authenticate: OAuth session expired and could not be refreshed
 *
 * Rotation never fired, because the only thing that triggers it is
 * `detectClaudeUsageLimitText` (claude-rate-limit.ts), whose pattern matches quota
 * exhaustion and nothing else. The severity is backwards: a quota limit is
 * self-healing, an expired login needs a human to run `claude login` — and the
 * self-healing one is the one with first-class handling.
 *
 * This module is deliberately a PURE predicate over the provider's error text, with
 * no DB or process access, so it is unit-testable without a broken login to
 * reproduce against — which matters because the failure it detects is precisely the
 * state you cannot conjure on demand.
 *
 * It is the classification step (step 1 of #430). Wiring it into rotation and into a
 * circuit-breaker are separate changes tracked on that ticket; this lands first so
 * both have something unambiguous to key off, and so the patterns can be reviewed
 * and extended on their own.
 */

export type ProviderAuthFailureKind =
  /** An OAuth/session credential expired or was revoked; refresh already failed. */
  | "oauth-expired"
  /** Credentials are absent entirely — never logged in, or the config dir is empty/wrong. */
  | "not-authenticated"
  /** The credential was rejected as invalid (bad/rotated API key, revoked token). */
  | "invalid-credentials";

export interface ProviderAuthFailure {
  kind: ProviderAuthFailureKind;
  /** The matched line, trimmed — for the failure record and the profile-health surface. */
  message: string;
}

/**
 * Ordered most-specific first: an expired OAuth session also contains the word
 * "authenticate", so a generic not-authenticated pattern must not claim it.
 *
 * Every pattern here describes a state a RETRY CANNOT FIX. Anything transient
 * (network blips, 5xx, timeouts) must stay out — misclassifying a transient failure
 * as terminal would stop a run that would have recovered on its own, which is a
 * worse outcome than the retry loop this is meant to end.
 */
const AUTH_FAILURE_PATTERNS: Array<{ kind: ProviderAuthFailureKind; pattern: RegExp }> = [
  {
    kind: "oauth-expired",
    // The live #430 string, plus the common refresh-failure phrasings.
    // The copula is optional AND variable ("is/was/has been revoked") — the first draft
    // only accepted "is", so "Your refresh token was revoked" fell through to the generic
    // bucket and produced the wrong remedy text. Caught by the table-driven test.
    pattern: /oauth\s+session\s+expired|session\s+expired\s+and\s+could\s+not\s+be\s+refreshed|refresh\s+token\s+(?:(?:is|was|has\s+been)\s+)?(?:expired|invalid|revoked)|token\s+(?:has\s+)?expired/i,
  },
  {
    kind: "invalid-credentials",
    pattern: /invalid\s+(?:api\s+)?(?:key|token|credentials)|authentication\s+failed|unauthorized|401\s+unauthorized|api\s+key\s+(?:is\s+)?(?:invalid|revoked)/i,
  },
  {
    kind: "not-authenticated",
    pattern: /not\s+(?:logged\s+in|authenticated)|no\s+(?:credentials|api\s+key)\s+found|please\s+(?:run\s+)?(?:`?claude\s+login`?|log\s?in)|failed\s+to\s+authenticate/i,
  },
];

/**
 * Classify a provider's error text. Returns null for anything not recognised as a
 * terminal auth problem — including transient network errors, which must keep their
 * existing retry behaviour.
 */
export function detectProviderAuthFailure(text: string | null | undefined): ProviderAuthFailure | null {
  if (!text) return null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    for (const { kind, pattern } of AUTH_FAILURE_PATTERNS) {
      if (pattern.test(trimmed)) return { kind, message: trimmed };
    }
  }
  return null;
}

/**
 * True when the failure means "this profile cannot serve until a human intervenes".
 *
 * All three kinds currently qualify — the distinction is kept for the operator-facing
 * message ("log in again" vs "no credentials at all" vs "the key was rejected"), not
 * because any of them is retryable. Callers should branch on THIS rather than on
 * `kind`, so adding a future recoverable kind is a one-line change here instead of a
 * hunt through every call site.
 */
export function isUnrecoverableAuthFailure(failure: ProviderAuthFailure | null): boolean {
  return failure !== null;
}

/** A short operator-facing remedy for the profile-health surface and failure record. */
export function authFailureRemedy(failure: ProviderAuthFailure, profileName?: string): string {
  const who = profileName ? `profile "${profileName}"` : "this profile";
  switch (failure.kind) {
    case "oauth-expired":
      return `The login for ${who} has expired — re-authenticate it (e.g. \`claude login\` against its config dir). Retrying cannot fix this.`;
    case "not-authenticated":
      return `${who} has no usable credentials — log in against its config dir before using it.`;
    case "invalid-credentials":
      return `The credentials for ${who} were rejected — replace the key or re-authenticate. Retrying cannot fix this.`;
  }
}
