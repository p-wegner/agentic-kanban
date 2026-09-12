import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "./helpers/test-db.js";
import { listAgentProfileHealth, preflightAgentProfile, recordAgentProfileLaunchFailure } from "../services/agent-profile-health.service.js";
import type { FileSystem } from "../services/agent-provider/types.js";

/**
 * #1106: `preflightAgentProfile`/`listAgentProfileHealth` build a real launch config for
 * every candidate, which (for claude/codex/copilot) writes the MACHINE-GLOBAL MCP config
 * path (`<tmpdir>/agentic-kanban-mcp-config.json`) unless a FileSystem is injected. That
 * path is shared by every checkout/process on the box, so a real write from a test run
 * (or a throwaway base-health-probe clone) poisons every agent launched afterwards with
 * paths that only exist inside this run. An in-memory fake keeps this suite from ever
 * touching that shared file.
 */
function inMemoryFs(): FileSystem {
  const files = new Map<string, string>();
  return {
    existsSync: (p) => files.has(p),
    readFileSync: (p) => {
      const content = files.get(p);
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return content;
    },
    writeFileSync: (p, data) => {
      files.set(p, data);
    },
  };
}

describe("agent profile health service", () => {
  it("persists and maps the latest launch failure summary by provider profile", async () => {
    const { db } = createTestDb();
    await recordAgentProfileLaunchFailure(db, {
      provider: "codex",
      profileName: "fast",
      summary: "Process error: sk-testsecret token=abc123",
      exitCode: 1,
      sessionId: "session-1",
      workspaceId: "workspace-1",
      at: "2026-06-01T12:00:00.000Z",
    });

    const rows = await listAgentProfileHealth(db, {
      claudeProfiles: [],
      codexProfiles: ["default", "fast"],
      copilotProfiles: ["default"],
      piProfiles: ["default"],
    }, inMemoryFs());

    const fast = rows.find((row) => row.id === "codex:fast");
    expect(fast?.status).toBe("error");
    expect(fast?.latestFailure).toMatchObject({
      provider: "codex",
      profileName: "fast",
      exitCode: 1,
      sessionId: "session-1",
      workspaceId: "workspace-1",
    });
    expect(fast?.latestFailure?.summary).toContain("[redacted]");
    expect(fast?.latestFailure?.summary).not.toContain("sk-testsecret");
    expect(fast?.latestFailure?.summary).not.toContain("abc123");
  });

  it("includes a default Pi profile and runs Pi launch preflight", async () => {
    const { db } = createTestDb();
    const rows = await listAgentProfileHealth(db, {
      claudeProfiles: [],
      codexProfiles: ["default"],
      copilotProfiles: ["default"],
      piProfiles: ["default"],
    }, inMemoryFs());

    const pi = rows.find((row) => row.id === "pi:default");
    expect(pi).toMatchObject({
      provider: "pi",
      profileName: "default",
    });
    expect(pi?.command).toMatch(/^pi(\.|$)/);
    expect(pi?.preflight.warnings).not.toContain("Pi launch preflight is pending provider implementation.");
  });

  it("applies pi_profile for Pi preflight selections", () => {
    const result = preflightAgentProfile(new Map([["pi_profile", "local"]]), "pi", "local", inMemoryFs());
    expect(result).toMatchObject({
      provider: "pi",
      profileName: "local",
    });
    expect(result.command).toMatch(/^pi(\.|$)/);
    expect(result.errors.some((error) => error.includes("Pi profile 'local' requires PI_CODING_AGENT_DIR"))).toBe(true);
  });

  it.each([
    ["claude", "Using default Claude command from PATH."],
    ["codex", "Using default Codex command from PATH."],
    ["copilot", "Using default Copilot command from PATH."],
    ["pi", "Using default Pi command from PATH."],
  ] as const)("warns about the default %s command when none is configured", (provider, message) => {
    const result = preflightAgentProfile(new Map(), provider, "default", inMemoryFs());
    expect(result.warnings).toContain(message);
  });

  it("reports a missing codex profile config file as an error", () => {
    const result = preflightAgentProfile(new Map(), "codex", "nonexistent-xyz", inMemoryFs());
    expect(result.errors.some((e) => e.includes("Profile config not found"))).toBe(true);
  });

  it("never touches the real machine-global MCP config path (#1106)", () => {
    // A FileSystem whose write throws proves the injected fs is what actually gets
    // called — regression guard for the poisoning bug, where every provider silently
    // fell back to the real nodeFileSystem default regardless of what a caller passed.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const guardFs: FileSystem = {
      existsSync: () => false,
      readFileSync: () => {
        throw new Error("should not be read");
      },
      writeFileSync: () => {
        throw new Error("must not write the real/shared filesystem from a test");
      },
    };
    expect(() => preflightAgentProfile(new Map(), "claude", "default", guardFs)).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to generate MCP config"));
    warnSpy.mockRestore();
  });
});
