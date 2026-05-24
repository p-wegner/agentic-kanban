import { describe, it, expect } from "vitest";
import { resolveAgentSettings } from "../services/agent-settings.service.js";

function prefs(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

describe("resolveAgentSettings - mock profile wiring", () => {
  it("uses the mock agent command when claude_profile is 'mock'", () => {
    const { agentCommand } = resolveAgentSettings(prefs({ claude_profile: "mock" }));
    expect(agentCommand).toContain("mock-agent");
  });

  it("appends configured mock_agent_profile and mock_agent_delay_ms as flags", () => {
    const { agentCommand } = resolveAgentSettings(
      prefs({ claude_profile: "mock", mock_agent_profile: "todo-progress", mock_agent_delay_ms: "250" }),
    );
    expect(agentCommand).toContain("--profile todo-progress");
    expect(agentCommand).toContain("--delay-ms 250");
  });

  it("does not pass the mock profile name through to Claude Code as claudeProfile", () => {
    const { claudeProfile } = resolveAgentSettings(prefs({ claude_profile: "mock" }));
    expect(claudeProfile).toBeUndefined();
  });

  it("ignores mock flags for a real (non-mock) profile", () => {
    const { agentCommand } = resolveAgentSettings(
      prefs({ claude_profile: "work", agent_command: "claude", mock_agent_profile: "todo-progress" }),
    );
    expect(agentCommand).toBe("claude");
  });

  it("rejects mock_agent_profile values with shell metacharacters", () => {
    const { agentCommand } = resolveAgentSettings(
      prefs({ claude_profile: "mock", mock_agent_profile: "x && rm -rf /" }),
    );
    expect(agentCommand).not.toContain("rm -rf");
    expect(agentCommand).not.toContain("--profile");
  });

  it("rejects non-numeric mock_agent_delay_ms", () => {
    const { agentCommand } = resolveAgentSettings(
      prefs({ claude_profile: "mock", mock_agent_delay_ms: "500; echo hi" }),
    );
    expect(agentCommand).not.toContain("--delay-ms");
    expect(agentCommand).not.toContain("echo");
  });
});

describe("resolveAgentSettings - provider/profile wiring", () => {
  it("defaults to Claude and keeps legacy claudeProfile", () => {
    const settings = resolveAgentSettings(prefs({ claude_profile: "work" }));
    expect(settings.provider).toBe("claude");
    expect(settings.claudeProfile).toBe("work");
    expect(settings.profile).toEqual({ provider: "claude", name: "work" });
  });

  it("uses codex_profile for Codex provider", () => {
    const settings = resolveAgentSettings(prefs({
      provider: "codex",
      claude_profile: "work",
      codex_profile: "fast",
    }));
    expect(settings.provider).toBe("codex");
    expect(settings.claudeProfile).toBe("work");
    expect(settings.profile).toEqual({ provider: "codex", name: "fast" });
  });

  it("uses copilot_profile for Copilot provider", () => {
    const settings = resolveAgentSettings(prefs({
      provider: "copilot",
      claude_profile: "work",
      copilot_profile: "gpt-5.2",
    }));
    expect(settings.provider).toBe("copilot");
    expect(settings.claudeProfile).toBe("work");
    expect(settings.profile).toEqual({ provider: "copilot", name: "gpt-5.2" });
  });

  it("does not append Claude skip-permissions flag for Copilot", () => {
    const settings = resolveAgentSettings(prefs({
      provider: "copilot",
      skip_permissions: "true",
      agent_args: "--allow-url github.com",
    }));
    expect(settings.agentArgs).toBe("--allow-url github.com");
  });

  it("still appends Claude skip-permissions flag for Claude", () => {
    const settings = resolveAgentSettings(prefs({
      provider: "claude",
      skip_permissions: "true",
      agent_args: "--model sonnet",
    }));
    expect(settings.agentArgs).toBe("--model sonnet --dangerously-skip-permissions");
  });

  it("falls back to Claude for unknown provider values", () => {
    const settings = resolveAgentSettings(prefs({ provider: "other", claude_profile: "work" }));
    expect(settings.provider).toBe("claude");
    expect(settings.profile).toEqual({ provider: "claude", name: "work" });
  });

  it("honors command overrides regardless of provider", () => {
    const settings = resolveAgentSettings(prefs({ provider: "copilot", agent_command: "copilot" }), "custom-agent");
    expect(settings.agentCommand).toBe("custom-agent");
    expect(settings.provider).toBe("copilot");
  });
});
