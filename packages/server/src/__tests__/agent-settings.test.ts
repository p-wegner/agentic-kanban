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
