import { describe, expect, it } from "vitest";
import {
  detectProviderAuthFailure,
  isUnrecoverableAuthFailure,
  authFailureRemedy,
} from "../services/provider-auth-failure.js";
import { detectClaudeUsageLimitText } from "../services/claude-rate-limit.js";

/**
 * #430 — the classifier that tells an EXPIRED LOGIN apart from a quota limit.
 *
 * The bug it comes from: a workspace burned 10 sessions in 91 seconds on one profile,
 * every one dying with "Failed to authenticate: OAuth session expired and could not be
 * refreshed", because rotation only ever fires on the usage-limit pattern and nothing
 * else classified the failure as terminal.
 *
 * The two risks worth locking down are opposite in direction:
 *   - a terminal auth failure NOT detected → the retry loop comes back;
 *   - a TRANSIENT failure detected as terminal → a run that would have recovered is
 *     killed instead, which is the worse of the two.
 * Both get explicit coverage below.
 */

/** The exact string observed in the live #430 session output. */
const LIVE_430_ERROR =
  "Agent launch failed: provider process exited within 10s with non-zero exit code 1 and error output:\n"
  + "Failed to authenticate: OAuth session expired and could not be refreshed";

describe("detectProviderAuthFailure", () => {
  it("detects the live #430 error and classifies it as an expired OAuth session", () => {
    const failure = detectProviderAuthFailure(LIVE_430_ERROR);
    expect(failure).not.toBeNull();
    expect(failure!.kind).toBe("oauth-expired");
    // The matched LINE, not the whole blob — this goes into the failure record.
    expect(failure!.message).toContain("OAuth session expired");
    expect(failure!.message).not.toContain("Agent launch failed");
  });

  it("prefers the specific oauth-expired classification over the generic one", () => {
    // "Failed to authenticate" alone is not-authenticated, but this line is ALSO an
    // expired session — the more specific kind must win, or the remedy text is wrong.
    const failure = detectProviderAuthFailure("Failed to authenticate: OAuth session expired and could not be refreshed");
    expect(failure!.kind).toBe("oauth-expired");
  });

  it.each([
    ["OAuth session expired", "oauth-expired"],
    ["refresh token is expired", "oauth-expired"],
    ["Your refresh token was revoked", "oauth-expired"],
    ["token has expired", "oauth-expired"],
    ["Invalid API key provided", "invalid-credentials"],
    ["401 Unauthorized", "invalid-credentials"],
    ["Authentication failed", "invalid-credentials"],
    ["You are not logged in", "not-authenticated"],
    ["not authenticated", "not-authenticated"],
    ["No credentials found", "not-authenticated"],
    ["Please run `claude login`", "not-authenticated"],
  ])("classifies %j as %s", (text, kind) => {
    expect(detectProviderAuthFailure(text)?.kind).toBe(kind);
  });

  it("does NOT claim transient failures — killing a recoverable run is the worse error", () => {
    for (const transient of [
      "connect ETIMEDOUT 1.2.3.4:443",
      "socket hang up",
      "read ECONNRESET",
      "503 Service Unavailable",
      "500 Internal Server Error",
      "fetch failed",
      "Overloaded",
      "request timed out after 60s",
      "getaddrinfo ENOTFOUND api.anthropic.com",
    ]) {
      expect(detectProviderAuthFailure(transient), transient).toBeNull();
    }
  });

  it("does not claim a QUOTA limit — that is the rotation path's job, not this one", () => {
    // The two classifiers must not both claim the same text, or rotation and the
    // auth circuit-breaker would fight over one failure.
    const quota = "Claude usage limit reached. Your limit will reset at 3pm.";
    expect(detectProviderAuthFailure(quota)).toBeNull();
    expect(detectClaudeUsageLimitText(quota)).not.toBeNull();

    // ...and conversely.
    expect(detectClaudeUsageLimitText("Failed to authenticate: OAuth session expired and could not be refreshed")).toBeNull();
  });

  it("returns null for empty, null and undefined input", () => {
    for (const empty of [null, undefined, "", "   ", "\n\n"]) {
      expect(detectProviderAuthFailure(empty)).toBeNull();
    }
  });

  it("finds the auth line anywhere in a multi-line blob", () => {
    const blob = [
      "some preamble",
      "  more noise  ",
      "Failed to authenticate: OAuth session expired and could not be refreshed",
      "trailing noise",
    ].join("\n");
    expect(detectProviderAuthFailure(blob)?.kind).toBe("oauth-expired");
  });
});

describe("isUnrecoverableAuthFailure", () => {
  it("is false for a non-failure and true for every detected kind", () => {
    expect(isUnrecoverableAuthFailure(null)).toBe(false);
    for (const text of ["OAuth session expired", "Invalid API key", "not logged in"]) {
      expect(isUnrecoverableAuthFailure(detectProviderAuthFailure(text))).toBe(true);
    }
  });
});

describe("authFailureRemedy", () => {
  it("names the profile and says plainly that retrying will not help", () => {
    const failure = detectProviderAuthFailure(LIVE_430_ERROR)!;
    const remedy = authFailureRemedy(failure, "andrena_team_5x_3");
    expect(remedy).toContain("andrena_team_5x_3");
    expect(remedy).toMatch(/retrying cannot fix this/i);
  });

  it("works without a profile name", () => {
    const failure = detectProviderAuthFailure("Invalid API key")!;
    expect(authFailureRemedy(failure)).toContain("this profile");
  });

  it("gives a distinct remedy per kind", () => {
    const kinds = ["OAuth session expired", "no credentials found", "Invalid API key"]
      .map((t) => authFailureRemedy(detectProviderAuthFailure(t)!));
    expect(new Set(kinds).size).toBe(3);
  });
});
