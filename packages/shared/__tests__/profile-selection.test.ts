// #528. The two boundary mappers between `ProfileSelection` and the legacy bare profile
// string. Small surface, but it encodes the invariant that the old scattered conversions
// got wrong, so the interesting cases are the non-claude ones.
import { describe, it, expect } from "vitest";
import { toProfileSelection, profileNameOf } from "../src/lib/profile-selection.js";

describe("profileNameOf", () => {
  it("keeps a NON-claude profile name — the bug this replaced", () => {
    // The call sites this consolidates spelled the conversion
    //   claudeProfile: provider === "claude" ? name : undefined
    // and then wrote the result to `workspaces.claude_profile` unconditionally. So saving
    // a codex workspace wrote NULL over its own profile, and the next launch — whose
    // reader treats that column as "this workspace's profile, whatever the provider" —
    // found nothing and silently fell back to the board's current codex default.
    expect(profileNameOf({ provider: "codex", name: "ki15" })).toBe("ki15");
    expect(profileNameOf({ provider: "copilot", name: "gpt-5.2" })).toBe("gpt-5.2");
    expect(profileNameOf({ provider: "pi", name: "local" })).toBe("local");
    expect(profileNameOf({ provider: "claude", name: "anth" })).toBe("anth");
  });

  it("returns null, not undefined, for no selection", () => {
    // Both consumers are a nullable column / nullable DTO field, and an explicit null is
    // what clears one. `undefined` would leave a drizzle `set` untouched instead.
    expect(profileNameOf(undefined)).toBeNull();
    expect(profileNameOf(null)).toBeNull();
  });
});

describe("toProfileSelection", () => {
  it("tags a stored name with the workspace's own provider", () => {
    expect(toProfileSelection("codex", "ki15")).toEqual({ provider: "codex", name: "ki15" });
    expect(toProfileSelection("claude", "anth")).toEqual({ provider: "claude", name: "anth" });
  });

  it("is undefined for an absent or empty name", () => {
    // Empty string is claude's own "use the CLI login" value (see PROVIDER_TRAITS), so it
    // must not become a selection naming a profile called "".
    expect(toProfileSelection("claude", null)).toBeUndefined();
    expect(toProfileSelection("claude", undefined)).toBeUndefined();
    expect(toProfileSelection("claude", "")).toBeUndefined();
  });

  it("narrows an unknown provider to claude, matching every other provider read", () => {
    expect(toProfileSelection("opencode", "x")).toEqual({ provider: "claude", name: "x" });
    expect(toProfileSelection(null, "x")).toEqual({ provider: "claude", name: "x" });
  });

  it("round-trips a non-claude selection through the column representation", () => {
    const selection = { provider: "codex" as const, name: "ki15" };
    expect(toProfileSelection("codex", profileNameOf(selection))).toEqual(selection);
  });
});
