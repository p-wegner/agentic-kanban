import { describe, it, expect } from "vitest";
import { getProviderExitBehavior } from "../services/agent-provider/provider-exit-behavior.js";
import type { AgentOutputMessage } from "@agentic-kanban/shared";
import type { CodexLicenseEntry } from "../services/codex-license-ring.js";
import type { ClaudeSubscriptionEntry } from "../services/claude-subscription-ring.js";

/**
 * Unit tests for the per-provider exit behaviors extracted from the session
 * lifecycle (#910). These move the `executor === "codex"` / `profile.provider ===
 * "claude"` special-cases onto the provider so the lifecycle stops being the
 * provider-knowledge sink. The behaviors are pure: usage-limit detection over the
 * exit output, OAuth config-dir rotation over a pre-loaded ring, and provider
 * builder-instruction injection.
 */

const msg = (data: string): AgentOutputMessage => ({ type: "stdout", data } as unknown as AgentOutputMessage);

describe("codex exit behavior", () => {
  const codex = getProviderExitBehavior("codex");

  it("detects a codex usage limit and tags it kind=codex with the retryAfter hint", () => {
    const messages = [
      msg(JSON.stringify({ type: "turn.started" })),
      msg(JSON.stringify({
        type: "turn.failed",
        error: { message: "You've hit your usage limit for GPT-5.3-Codex-Spark. Switch to another model now, or try again at Jun 6th, 2026 12:30 AM." },
      })),
    ];
    const limit = codex.detectUsageLimit(messages);
    expect(limit).not.toBeNull();
    expect(limit!.kind).toBe("codex");
    expect(limit!.retryAfter).toBe("Jun 6th, 2026 12:30 AM");
    expect(limit!.message).toContain("usage limit");
  });

  it("returns null when there is no usage-limit signature", () => {
    expect(codex.detectUsageLimit([msg("just normal output")])).toBeNull();
  });

  it("resolves CODEX_HOME for a ring license that declares a codexHome", () => {
    const ring: CodexLicenseEntry[] = [{ profile: "ki15", codexHome: "C:/home/.codex-ki15" }];
    const rotation = codex.resolveConfigDir("ki15", { codex: ring });
    expect(rotation).toEqual({ envVar: "CODEX_HOME", dir: "C:/home/.codex-ki15" });
  });

  it("returns undefined for an API-key (configToml) license — no home override", () => {
    const ring: CodexLicenseEntry[] = [{ profile: "apikey", configToml: "apikey.config.toml" }];
    expect(codex.resolveConfigDir("apikey", { codex: ring })).toBeUndefined();
  });

  it("returns undefined for the default profile", () => {
    expect(codex.resolveConfigDir("default", { codex: [] })).toBeUndefined();
  });

  it("appends the codex builder counter-instructions, preserving the base", () => {
    const out = codex.injectBuilderInstructions("Base guardrails.");
    expect(out).toContain("Base guardrails.");
    expect(out).toContain("MUST run relevant tests and COMMIT");
  });

  it("does not double-append the counter-instructions", () => {
    const once = codex.injectBuilderInstructions("Base.");
    const twice = codex.injectBuilderInstructions(once);
    expect(twice).toBe(once);
  });

  it("uses only the counter-instructions when the base is empty", () => {
    const out = codex.injectBuilderInstructions(undefined);
    expect(out).toContain("MUST run relevant tests and COMMIT");
  });
});

describe("claude exit behavior", () => {
  const claude = getProviderExitBehavior("claude");

  it("detects a claude subscription usage limit and tags it kind=claude", () => {
    const messages = [msg("Claude usage limit reached. Your limit will reset at 3pm.")];
    const limit = claude.detectUsageLimit(messages);
    expect(limit).not.toBeNull();
    expect(limit!.kind).toBe("claude");
    expect(limit!.message).toContain("usage limit reached");
  });

  it("resolves CLAUDE_CONFIG_DIR for a ring subscription with a configDir", () => {
    const ring: ClaudeSubscriptionEntry[] = [{ profile: "max2", configDir: "C:/home/.claude-max2" }];
    const rotation = claude.resolveConfigDir("max2", { claude: ring });
    expect(rotation).toEqual({ envVar: "CLAUDE_CONFIG_DIR", dir: "C:/home/.claude-max2" });
  });

  it("returns undefined for an API-key (settingsProfile) subscription", () => {
    const ring: ClaudeSubscriptionEntry[] = [{ profile: "key", settingsProfile: "settings_key.json" }];
    expect(claude.resolveConfigDir("key", { claude: ring })).toBeUndefined();
  });

  it("returns undefined for the mock profile", () => {
    expect(claude.resolveConfigDir("mock", { claude: [] })).toBeUndefined();
  });

  it("does NOT inject codex counter-instructions (leaves base unchanged)", () => {
    expect(claude.injectBuilderInstructions("Base guardrails.")).toBe("Base guardrails.");
    expect(claude.injectBuilderInstructions(undefined)).toBeUndefined();
  });
});

describe("noop providers (copilot, pi)", () => {
  it.each(["copilot", "pi"] as const)("%s has no usage-limit, config-dir, or instruction behavior", (provider) => {
    const behavior = getProviderExitBehavior(provider);
    expect(behavior.detectUsageLimit([msg("You've hit your usage limit for X")])).toBeNull();
    expect(behavior.resolveConfigDir("anything", {})).toBeUndefined();
    expect(behavior.injectBuilderInstructions("Base.")).toBe("Base.");
  });
});
