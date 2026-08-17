// @covers shared.provider-traits [correctness, ui-contract]
//
// #493. The client re-derived the claude/codex/copilot/pi ladder by hand in nine places
// and the copies drifted. The bug that motivates this table is asserted first: the
// workspace-launch form's private `profileOptionLabel` omitted `pi`, so a `pi` profile
// rendered as "Claude: <name>" — the form named the wrong agent.
import { describe, it, expect } from "vitest";
import {
  PROVIDER_TRAITS,
  AGENT_PROVIDER_NAMES,
  narrowProvider,
  providerLabel,
  profileOptionLabel,
  defaultProfileToken,
} from "../src/lib/provider-traits.js";

describe("profileOptionLabel (#493)", () => {
  it("labels a pi profile as Pi, not Claude", async () => {
    // The regression. `pi` fell off the end of a `?:` ladder whose final arm was "Claude".
    expect(profileOptionLabel("pi", "p2")).toBe("Pi: p2");
    expect(profileOptionLabel("pi", "default")).toBe("Pi: Default");
  });

  it("labels every other provider", () => {
    expect(profileOptionLabel("claude", "anth")).toBe("Claude: anth");
    expect(profileOptionLabel("codex", "default")).toBe("Codex: Default");
    expect(profileOptionLabel("copilot", "default")).toBe("Copilot: Default");
  });

  it("treats each provider's OWN default name as Default", () => {
    // Not a single `name === "default"` test: claude's default profile is "", so the
    // literal string "default" is a real, named claude profile and must not be relabelled.
    expect(profileOptionLabel("claude", "")).toBe("Claude: Default");
    expect(profileOptionLabel("claude", "default")).toBe("Claude: default");
    expect(profileOptionLabel("codex", "")).toBe("Codex: ");
  });

  it("falls back to Claude for an unknown provider, as the ladders did", () => {
    expect(profileOptionLabel("opencode", "x")).toBe("Claude: x");
  });
});

describe("defaultProfileToken (#493)", () => {
  it("reads each provider's own profile preference", () => {
    expect(defaultProfileToken({ provider: "codex", codex_profile: "work" })).toBe("codex:work");
    expect(defaultProfileToken({ provider: "pi", pi_profile: "p2" })).toBe("pi:p2");
    expect(defaultProfileToken({ provider: "claude", claude_profile: "anth" })).toBe("claude:anth");
  });

  it("uses the provider's default name when its preference is unset", () => {
    expect(defaultProfileToken({ provider: "copilot" })).toBe("copilot:default");
    expect(defaultProfileToken({ provider: "pi" })).toBe("pi:default");
  });

  it("keeps the claude fallback caller-chosen", () => {
    // Three copies disagreed ("", "default", "none") and each surface's text is pinned by
    // its own test. The parameter unifies the LADDER without silently changing displayed
    // text; choosing one word is a UX call, deliberately left out of this refactor.
    expect(defaultProfileToken({})).toBe("claude:none");
    expect(defaultProfileToken({}, "default")).toBe("claude:default");
  });
});

describe("the table is the single source (#493)", () => {
  it("covers every declared provider name", () => {
    // A fifth provider (an OpenCode adapter is foreseeable) must be one ROW, not ~15
    // scattered edits — this fails if a name is added without its traits.
    for (const name of AGENT_PROVIDER_NAMES) {
      expect(PROVIDER_TRAITS[name]).toBeDefined();
      expect(PROVIDER_TRAITS[name].label).toBeTruthy();
      expect(PROVIDER_TRAITS[name].profilePrefKey).toMatch(/_profile$/);
    }
    expect(Object.keys(PROVIDER_TRAITS).sort()).toEqual([...AGENT_PROVIDER_NAMES].sort());
  });

  it("narrows unknown values to claude", () => {
    expect(narrowProvider(undefined)).toBe("claude");
    expect(narrowProvider("nonsense")).toBe("claude");
    expect(narrowProvider("pi")).toBe("pi");
  });

  it("providerLabel matches the table", () => {
    expect(providerLabel("pi")).toBe("Pi");
    expect(providerLabel("copilot")).toBe("Copilot");
  });
});
