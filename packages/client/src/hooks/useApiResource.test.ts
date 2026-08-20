// @covers client.useApiResource [contract, error-handling]
//
// #513. The fetch-in-effect ladder (data/loading/error + cancelled flag + retryKey) was
// repeated across ~40 panels. Two decisions in it silently varied and are pinned here.
//
// SCOPE, stated honestly: this package's convention is pure-function tests with no
// `@testing-library/react` (see the note at the top of OnboardingWizard.test.tsx), so the
// EFFECT — including the cancelled guard that is the main reason the hook exists — has no
// unit test. It is covered only by the migrated panels' behaviour in the full client
// suite. Testing it properly would mean adding a hook-testing harness, which is a
// dependency decision outside this ticket.
import { describe, it, expect } from "vitest";
import { shouldFetch, normalizeFetchError } from "./useApiResource.js";

describe("shouldFetch (#513)", () => {
  it("skips a null path — 'nothing to load yet', not an error", () => {
    // A panel whose projectId is still null must render its empty state, NOT fire a
    // request for `/api/projects/null/board` and NOT sit on a spinner forever.
    expect(shouldFetch(null, true)).toBe(false);
  });

  it("skips while disabled, even with a path", () => {
    expect(shouldFetch("/api/x", false)).toBe(false);
  });

  it("fetches when there is a path and nothing gating it", () => {
    expect(shouldFetch("/api/x", true)).toBe(true);
  });

  it("treats the empty string as a real path, not as absent", () => {
    // `""` is falsy but is not `null`; conflating them is how a "no path" check turns
    // into a silent skip for a legitimately relative request.
    expect(shouldFetch("", true)).toBe(true);
  });
});

describe("normalizeFetchError (#513)", () => {
  it("prefers the Error's message", () => {
    expect(normalizeFetchError(new Error("boom"), "Failed to load data")).toBe("boom");
  });

  it("falls back for a non-Error throw", () => {
    // apiFetch can reject with a non-Error (a string, a rejected value); the 37 hand
    // copies all had this ternary, and the fallback text is what the user reads.
    expect(normalizeFetchError("just a string", "Failed to load burndown data"))
      .toBe("Failed to load burndown data");
    expect(normalizeFetchError(undefined, "Failed to load board data"))
      .toBe("Failed to load board data");
  });

  it("keeps an empty Error message rather than substituting the fallback", () => {
    // `new Error("")` is still an Error. Substituting here would hide a real (if terse)
    // failure behind a generic one.
    expect(normalizeFetchError(new Error(""), "fallback")).toBe("");
  });
});
