import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock node:child_process before importing
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}));

// Mock node:fs
vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
}));

import { ClaudeProvider, getProvider, buildAgentLaunchConfig } from "../services/agent-provider.js";
import { execSync as execSyncMock } from "node:child_process";
import { existsSync as existsSyncMock } from "node:fs";

const provider = new ClaudeProvider();

describe("ClaudeProvider", () => {
  const originalAgentCommand = process.env.AGENT_COMMAND;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AGENT_COMMAND;
  });

  afterEach(() => {
    if (originalAgentCommand !== undefined) {
      process.env.AGENT_COMMAND = originalAgentCommand;
    } else {
      delete process.env.AGENT_COMMAND;
    }
  });

  describe("buildLaunchConfig", () => {
    it("returns provider name as 'claude'", () => {
      expect(provider.name).toBe("claude");
    });

    it("builds default Claude launch config with stream-json", () => {
      const config = provider.buildLaunchConfig({});
      expect(config.command).toBe("claude");
      expect(config.args).toContain("--output-format");
      expect(config.args).toContain("stream-json");
      expect(config.args).toContain("--verbose");
      expect(config.args[config.args.length - 1]).toBe("-p");
      expect(config.isMockAgent).toBe(false);
      expect(config.keepStdinOpen).toBeFalsy();
    });

    it("detects mock agent from AGENT_COMMAND env var", () => {
      process.env.AGENT_COMMAND = "mock-agent";
      const config = provider.buildLaunchConfig({});
      expect(config.command).toBe("mock-agent");
      expect(config.isMockAgent).toBe(true);
      expect(config.args).not.toContain("--output-format");
    });

    it("detects mock agent from agentCommand containing 'mock-agent'", () => {
      const config = provider.buildLaunchConfig({ agentCommand: "node mock-agent.mjs" });
      expect(config.isMockAgent).toBe(true);
    });

    it("uses agentCommand for non-mock custom commands", () => {
      const config = provider.buildLaunchConfig({ agentCommand: "/usr/local/bin/custom-agent" });
      expect(config.command).toBe("/usr/local/bin/custom-agent");
      expect(config.isMockAgent).toBe(false);
      // Should still build Claude flags for non-mock custom commands
      expect(config.args).toContain("--output-format");
    });

    it("resolves claude.exe on Windows for default command", () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32" });

      (execSyncMock as any).mockReturnValue("C:\\Users\\test\\claude.exe\n");
      const config = provider.buildLaunchConfig({});
      expect(config.command).toBe("C:\\Users\\test\\claude.exe");

      Object.defineProperty(process, "platform", { value: originalPlatform });
    });

    it("skips .exe resolution when agentCommand is set", () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32" });

      const config = provider.buildLaunchConfig({ agentCommand: "custom-agent" });
      expect(config.command).toBe("custom-agent");
      expect(execSyncMock).not.toHaveBeenCalled();

      Object.defineProperty(process, "platform", { value: originalPlatform });
    });

    it("adds --resume with providerSessionId", () => {
      const config = provider.buildLaunchConfig({ providerSessionId: "sess-123" });
      const resumeIdx = config.args.indexOf("--resume");
      expect(resumeIdx).toBeGreaterThanOrEqual(0);
      expect(config.args[resumeIdx + 1]).toBe("sess-123");
    });

    it("adds --resume for mock agent too", () => {
      process.env.AGENT_COMMAND = "mock-agent";
      const config = provider.buildLaunchConfig({ providerSessionId: "sess-456" });
      expect(config.args).toContain("--resume");
      expect(config.args).toContain("sess-456");
    });

    it("adds plan mode flags", () => {
      const config = provider.buildLaunchConfig({ planMode: true });
      expect(config.args).toContain("--permission-mode");
      expect(config.args).toContain("plan");
      expect(config.args).toContain("--append-system-prompt");
      const promptIdx = config.args.indexOf("--append-system-prompt");
      expect(config.args[promptIdx + 1]).toContain("PLAN-ONLY session");
    });

    it("adds --permission-prompt-tool", () => {
      const config = provider.buildLaunchConfig({ permissionPromptTool: "mcp__approve" });
      expect(config.args).toContain("--permission-prompt-tool");
      expect(config.args).toContain("mcp__approve");
    });

    it("adds --settings when claudeProfile points to existing file", () => {
      (existsSyncMock as any).mockImplementation((p: string) =>
        p.includes("settings_test-profile.json")
      );

      const config = provider.buildLaunchConfig({ claudeProfile: "test-profile" });
      expect(config.args).toContain("--settings");
      const settingsIdx = config.args.indexOf("--settings");
      expect(config.args[settingsIdx + 1]).toContain("settings_test-profile.json");
    });

    it("skips --settings when profile file does not exist", () => {
      (existsSyncMock as any).mockReturnValue(false);

      const config = provider.buildLaunchConfig({ claudeProfile: "nonexistent" });
      expect(config.args).not.toContain("--settings");
    });

    it("sets keepStdinOpen for mock agent with keepAlive", () => {
      process.env.AGENT_COMMAND = "mock-agent";
      const config = provider.buildLaunchConfig({ keepAlive: true });
      expect(config.keepStdinOpen).toBe(true);
      expect(config.args).toContain("--profile");
      expect(config.args).toContain("multi-turn");
    });

    it("does not set keepStdinOpen for real Claude", () => {
      const config = provider.buildLaunchConfig({ keepAlive: true });
      expect(config.keepStdinOpen).toBeFalsy();
    });

    it("splits agentArgs correctly", () => {
      const config = provider.buildLaunchConfig({ agentArgs: '--flag1 value1 --flag2 "multi word"' });
      expect(config.args).toContain("--flag1");
      expect(config.args).toContain("value1");
      expect(config.args).toContain("--flag2");
      expect(config.args).toContain("multi word");
    });

    it("sets useShell on Windows for mock agent", () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32" });

      process.env.AGENT_COMMAND = "mock-agent";
      const config = provider.buildLaunchConfig({});
      expect(config.useShell).toBe(true);

      Object.defineProperty(process, "platform", { value: originalPlatform });
    });

    it("sets useShell on Windows for custom agentCommand", () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32" });

      const config = provider.buildLaunchConfig({ agentCommand: "custom-agent" });
      expect(config.useShell).toBe(true);

      Object.defineProperty(process, "platform", { value: originalPlatform });
    });

    it("sets useShell=false for default Claude on Windows", () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32" });
      (execSyncMock as any).mockReturnValue("C:\\path\\claude.exe\n");

      const config = provider.buildLaunchConfig({});
      expect(config.useShell).toBe(false);

      Object.defineProperty(process, "platform", { value: originalPlatform });
    });
  });

  describe("parseStreamEvent", () => {
    it("returns undefined for non-JSON lines", () => {
      expect(provider.parseStreamEvent("not json")).toBeUndefined();
      expect(provider.parseStreamEvent("")).toBeUndefined();
    });

    it("extracts providerSessionId from system/init event", () => {
      const evt = provider.parseStreamEvent(
        JSON.stringify({ type: "system", subtype: "init", session_id: "abc-123" })
      );
      expect(evt?.providerSessionId).toBe("abc-123");
    });

    it("returns undefined for system/init without session_id", () => {
      const evt = provider.parseStreamEvent(
        JSON.stringify({ type: "system", subtype: "init" })
      );
      expect(evt).toBeUndefined();
    });

    it("extracts stats from result event", () => {
      const evt = provider.parseStreamEvent(
        JSON.stringify({
          type: "result",
          subtype: "success",
          duration_ms: 5000,
          cost_usd: 0.05,
          usage: { input_tokens: 100, output_tokens: 200 },
          num_turns: 3,
          model: "claude-sonnet-4-6",
          result: "Done",
        })
      );
      expect(evt?.stats).toEqual({
        durationMs: 5000,
        totalCostUsd: 0.05,
        inputTokens: 100,
        outputTokens: 200,
        numTurns: 3,
        model: "claude-sonnet-4-6",
        success: true,
        agentSummary: "Done",
      });
      expect(evt?.turnComplete).toBe(true);
    });

    it("marks stats as failed on error result", () => {
      const evt = provider.parseStreamEvent(
        JSON.stringify({ type: "result", subtype: "error", is_error: true })
      );
      expect(evt?.stats?.success).toBe(false);
    });

    it("extracts liveStats from assistant event", () => {
      const evt = provider.parseStreamEvent(
        JSON.stringify({
          type: "assistant",
          message: {
            model: "claude-opus-4-7",
            usage: { input_tokens: 500, cache_read_input_tokens: 1000 },
          },
        })
      );
      expect(evt?.liveStats?.model).toBe("claude-opus-4-7");
      expect(evt?.liveStats?.contextTokens).toBe(1500);
    });

    it("extracts toolActivity from tool_use block", () => {
      const evt = provider.parseStreamEvent(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", name: "Read", id: "tu-1", input: { file_path: "/foo.ts" } },
            ],
          },
        })
      );
      expect(evt?.toolActivity?.name).toBe("Read");
      expect(evt?.toolActivity?.input).toEqual({ file_path: "/foo.ts" });
      expect(evt?.toolActivity?.toolUseId).toBe("tu-1");
    });

    it("extracts todos from TodoWrite tool_use", () => {
      const evt = provider.parseStreamEvent(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                name: "TodoWrite",
                id: "tu-2",
                input: {
                  todos: [
                    { subject: "Task 1", status: "pending" },
                    { subject: "Task 2", status: "completed" },
                  ],
                },
              },
            ],
          },
        })
      );
      expect(evt?.todos).toEqual([
        { subject: "Task 1", status: "pending" },
        { subject: "Task 2", status: "completed" },
      ]);
    });

    it("detects Agent tool_use with subagentDelta", () => {
      const evt = provider.parseStreamEvent(
        JSON.stringify({
          type: "assistant",
          message: {
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 100 },
            content: [
              { type: "tool_use", name: "Agent", id: "tu-3", input: { prompt: "Do stuff" } },
            ],
          },
        })
      );
      expect(evt?.liveStats?.subagentDelta).toBe(1);
    });

    it("extracts toolUses from task_progress event", () => {
      const evt = provider.parseStreamEvent(
        JSON.stringify({
          type: "system",
          subtype: "task_progress",
          usage: { tool_uses: 42 },
        })
      );
      expect(evt?.liveStats?.toolUses).toBe(42);
    });

    it("extracts toolResult from user tool_result block", () => {
      const evt = provider.parseStreamEvent(
        JSON.stringify({
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "tu-1" },
            ],
          },
        })
      );
      expect(evt?.toolResult?.toolUseId).toBe("tu-1");
    });

    it("parses rate_limit_event", () => {
      const evt = provider.parseStreamEvent(
        JSON.stringify({
          type: "rate_limit_event",
          rate_limit_info: {
            status: "allowed",
            rateLimitType: "five_hour",
            resetsAt: 1779492000,
            overageStatus: "rejected",
            overageDisabledReason: "org_level_disabled",
            isUsingOverage: false,
          },
          uuid: "a64f60d7-08b9-4205-9a86-9fb0836be447",
          session_id: "594ffd37-ba74-490e-bad1-e03d3121a992",
        })
      );
      expect(evt?.rateLimitInfo?.status).toBe("allowed");
      expect(evt?.rateLimitInfo?.rateLimitType).toBe("five_hour");
      expect(evt?.rateLimitInfo?.resetsAt).toBe(1779492000);
      expect(evt?.rateLimitInfo?.overageDisabledReason).toBe("org_level_disabled");
      expect(evt?.rateLimitInfo?.isUsingOverage).toBe(false);
    });

    it("returns undefined for unrecognized JSON events", () => {
      const evt = provider.parseStreamEvent(
        JSON.stringify({ type: "unknown", data: "stuff" })
      );
      expect(evt).toBeUndefined();
    });

    it("returns contextTokens from result event usage", () => {
      const evt = provider.parseStreamEvent(
        JSON.stringify({
          type: "result",
          subtype: "success",
          usage: { input_tokens: 200, cache_read_input_tokens: 300 },
        })
      );
      expect(evt?.liveStats?.contextTokens).toBe(500);
    });
  });
});

describe("provider registry", () => {
  it("getProvider returns ClaudeProvider by default", () => {
    const p = getProvider();
    expect(p.name).toBe("claude");
    expect(p).toBeInstanceOf(ClaudeProvider);
  });

  it("getProvider throws for unknown provider", () => {
    expect(() => getProvider("nonexistent")).toThrow("Unknown agent provider");
  });
});

describe("buildAgentLaunchConfig (backward compat)", () => {
  const originalAgentCommand = process.env.AGENT_COMMAND;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AGENT_COMMAND;
  });

  afterEach(() => {
    if (originalAgentCommand !== undefined) {
      process.env.AGENT_COMMAND = originalAgentCommand;
    } else {
      delete process.env.AGENT_COMMAND;
    }
  });

  it("delegates to default provider (claude)", () => {
    const config = buildAgentLaunchConfig({});
    expect(config.args).toContain("--output-format");
    expect(config.args).toContain("stream-json");
  });

  it("passes options through to provider", () => {
    process.env.AGENT_COMMAND = "mock-agent";
    const config = buildAgentLaunchConfig({ providerSessionId: "sess-789" });
    expect(config.args).toContain("sess-789");
  });
});
