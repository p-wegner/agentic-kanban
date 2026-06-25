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
  it("requestedModel overrides the provider-scoped default for claude", () => {
    const r = resolveProviderConfig({
      prefMap: prefs({ provider: "claude", claude_profile: "anth", default_model_claude: "sonnet" }),
      requestedModel: "opus",
    });
    expect(r.model).toBe("opus");
  });

  it("falls back to the provider-scoped default when no requestedModel (codex)", () => {
    const r = resolveProviderConfig({
      prefMap: prefs({ provider: "codex", codex_profile: "ki14", default_model_codex: "gpt-5.5" }),
    });
    expect(r.model).toBe("gpt-5.5");
  });

  it("ignores the retired global default_model — only the provider-scoped slot is consulted (#902)", () => {
    const r = resolveProviderConfig({
      prefMap: prefs({
        provider: "claude",
        claude_profile: "anth",
        default_model: "gpt-5.5", // legacy global key — must have no effect
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

  it("a stale global default_model never leaks into a launch — it is unrepresentable now (#902/#696)", () => {
    // Pre-#902 this was the footgun: a leftover global `default_model=gpt-5.5` (a Codex id)
    // got fed to claude.exe and killed every launch. Now the global key is simply not read,
    // so with no provider-scoped slot set the model is undefined (provider default).
    const r = resolveProviderConfig({
      prefMap: prefs({ provider: "claude", claude_profile: "anth", default_model: "gpt-5.5" }),
    });
    expect(r.model).toBeUndefined();
  });

  it("global default_model has no effect for codex either", () => {
    const r = resolveProviderConfig({
      prefMap: prefs({ provider: "codex", codex_profile: "ki14", default_model: "opus" }),
    });
    expect(r.model).toBeUndefined();
  });

  it("copilot never gets a model (no model flag)", () => {
    const r = resolveProviderConfig({
      prefMap: prefs({ provider: "copilot", copilot_profile: "gh", default_model_codex: "gpt-5.5" }),
    });
    expect(r.model).toBeUndefined();
  });

  it("whitespace-only requestedModel is ignored, falls back to the provider-scoped default", () => {
    const r = resolveProviderConfig({
      prefMap: prefs({ provider: "claude", claude_profile: "anth", default_model_claude: "opus" }),
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
