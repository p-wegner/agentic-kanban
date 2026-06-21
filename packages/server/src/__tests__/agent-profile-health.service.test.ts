import { describe, expect, it } from "vitest";
import { createTestDb } from "./helpers/test-db.js";
import { listAgentProfileHealth, preflightAgentProfile, recordAgentProfileLaunchFailure } from "../services/agent-profile-health.service.js";

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
    });

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
    });

    const pi = rows.find((row) => row.id === "pi:default");
    expect(pi).toMatchObject({
      provider: "pi",
      profileName: "default",
    });
    expect(pi?.command).toMatch(/^pi(\.|$)/);
    expect(pi?.preflight.warnings).not.toContain("Pi launch preflight is pending provider implementation.");
  });

  it("applies pi_profile for Pi preflight selections", () => {
    const result = preflightAgentProfile(new Map([["pi_profile", "local"]]), "pi", "local");
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
    const result = preflightAgentProfile(new Map(), provider, "default");
    expect(result.warnings).toContain(message);
  });

  it("reports a missing codex profile config file as an error", () => {
    const result = preflightAgentProfile(new Map(), "codex", "nonexistent-xyz");
    expect(result.errors.some((e) => e.includes("Profile config not found"))).toBe(true);
  });
});
