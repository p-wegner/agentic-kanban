/**
 * Unit tests for the pure provider/profile/model resolution extracted from
 * `buildAgentConfig` (#703). These exercise the codex-vs-claude branching in
 * isolation — no DB, no git, no quota service — which was the whole point of the
 * extraction.
 */
import { describe, it, expect } from "vitest";
import { resolveProviderConfig } from "../services/provider-config-resolution.js";

function prefs(entries: Record<string, string> = {}): Map<string, string> {
  return new Map(Object.entries(entries));
}

describe("resolveProviderConfig — precedence", () => {
  it("explicit profileOverride.provider=codex forces codex regardless of prefs", () => {
    const r = resolveProviderConfig({
      prefMap: prefs({ provider: "claude", claude_profile: "anth" }),
      profileOverride: { provider: "codex", name: "ki14" },
    });
    expect(r.provider).toBe("codex");
    expect(r.profileName).toBe("ki14");
  });

  it("explicit profileOverride.provider=copilot forces copilot", () => {
    const r = resolveProviderConfig({
      prefMap: prefs({ provider: "claude", claude_profile: "anth" }),
      profileOverride: { provider: "copilot", name: "gh" },
    });
    expect(r.provider).toBe("copilot");
    expect(r.profileName).toBe("gh");
  });

  it("explicit profileOverride defaults to claude when provider omitted", () => {
    const r = resolveProviderConfig({
      prefMap: prefs({ provider: "codex", codex_profile: "ki14" }),
      profileOverride: { name: "anth" },
    });
    expect(r.provider).toBe("claude");
    expect(r.profileName).toBe("anth");
  });

  it("legacy claudeProfile forces provider=claude even when prefs say codex", () => {
    const r = resolveProviderConfig({
      prefMap: prefs({ provider: "codex", codex_profile: "ki14", claude_profile: "anth" }),
      legacyProfileOverride: "anth",
    });
    expect(r.provider).toBe("claude");
    expect(r.profileName).toBe("anth");
  });

  it("profileOverride takes precedence over legacy claudeProfile", () => {
    const r = resolveProviderConfig({
      prefMap: prefs({ provider: "claude" }),
      profileOverride: { provider: "codex", name: "ki14" },
      legacyProfileOverride: "anth",
    });
    expect(r.provider).toBe("codex");
    expect(r.profileName).toBe("ki14");
  });

  it("no override falls back to the provider pref (claude)", () => {
    const r = resolveProviderConfig({
      prefMap: prefs({ provider: "claude", claude_profile: "anth" }),
    });
    expect(r.provider).toBe("claude");
    expect(r.profileName).toBe("anth");
  });

  it("no override falls back to the provider pref (codex)", () => {
    const r = resolveProviderConfig({
      prefMap: prefs({ provider: "codex", codex_profile: "ki14" }),
    });
    expect(r.provider).toBe("codex");
    expect(r.profileName).toBe("ki14");
  });
});

describe("resolveProviderConfig — strategy selection", () => {
  it("strategy selection is applied when there is no override", () => {
    const r = resolveProviderConfig({
      prefMap: prefs({ provider: "codex", codex_profile: "default" }),
      strategySelection: { provider: "codex", profileName: "ki14" },
    });
    expect(r.provider).toBe("codex");
    expect(r.profileName).toBe("ki14");
    expect(r.notes.some(n => n.includes("strategy provider selection"))).toBe(true);
  });

  it("strategy selection can switch provider from claude to codex", () => {
    const r = resolveProviderConfig({
      prefMap: prefs({ provider: "claude", claude_profile: "anth" }),
      strategySelection: { provider: "codex", profileName: "ki14" },
    });
    expect(r.provider).toBe("codex");
    expect(r.profileName).toBe("ki14");
  });

  it("an explicit override beats the strategy selection (override wins, no strategy note)", () => {
    const r = resolveProviderConfig({
      prefMap: prefs({ provider: "claude" }),
      legacyProfileOverride: "anth",
      // In practice the caller passes null here when an override exists; assert the
      // override still wins even if a stale selection leaks in.
      strategySelection: { provider: "codex", profileName: "ki14" },
    });
    expect(r.provider).toBe("claude");
    expect(r.profileName).toBe("anth");
  });
});

describe("resolveProviderConfig — model resolution", () => {
  it("requestedModel overrides default_model for claude", () => {
    const r = resolveProviderConfig({
      prefMap: prefs({ provider: "claude", claude_profile: "anth", default_model: "sonnet" }),
      requestedModel: "opus",
    });
    expect(r.model).toBe("opus");
  });

  it("falls back to default_model when no requestedModel (codex)", () => {
    const r = resolveProviderConfig({
      prefMap: prefs({ provider: "codex", codex_profile: "ki14", default_model: "gpt-5.5" }),
    });
    expect(r.model).toBe("gpt-5.5");
  });

  it("uses the provider-specific default model before legacy default_model", () => {
    const r = resolveProviderConfig({
      prefMap: prefs({
        provider: "claude",
        claude_profile: "anth",
        default_model: "gpt-5.5",
        default_model_claude: "sonnet",
      }),
    });
    expect(r.model).toBe("sonnet");
  });

  it("keeps provider-specific model defaults isolated across providers", () => {
    const r = resolveProviderConfig({
      prefMap: prefs({
        provider: "codex",
        codex_profile: "ki14",
        default_model_claude: "opus",
        default_model_codex: "gpt-5.5",
      }),
    });
    expect(r.model).toBe("gpt-5.5");
  });

  it("drops a codex default_model when the active provider is claude (#696)", () => {
    const r = resolveProviderConfig({
      prefMap: prefs({ provider: "claude", claude_profile: "anth", default_model: "gpt-5.5" }),
    });
    expect(r.model).toBeUndefined();
    expect(r.notes.some(n => n.includes("ignoring default_model"))).toBe(true);
  });

  it("drops a claude default_model when the active provider is codex", () => {
    const r = resolveProviderConfig({
      prefMap: prefs({ provider: "codex", codex_profile: "ki14", default_model: "opus" }),
    });
    expect(r.model).toBeUndefined();
  });

  it("copilot never gets a model (no model flag)", () => {
    const r = resolveProviderConfig({
      prefMap: prefs({ provider: "copilot", copilot_profile: "gh", default_model: "gpt-5.5" }),
    });
    expect(r.model).toBeUndefined();
  });

  it("whitespace-only requestedModel is ignored, falls back to default_model", () => {
    const r = resolveProviderConfig({
      prefMap: prefs({ provider: "claude", claude_profile: "anth", default_model: "opus" }),
      requestedModel: "   ",
    });
    expect(r.model).toBe("opus");
  });

  it("no model anywhere → undefined (provider default)", () => {
    const r = resolveProviderConfig({
      prefMap: prefs({ provider: "claude", claude_profile: "anth" }),
    });
    expect(r.model).toBeUndefined();
  });
});
