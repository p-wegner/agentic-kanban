import { describe, expect, it, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { createToolHarness, parseResult } from "../helpers/tool-harness.js";
import { seedIssue, seedProject } from "../helpers/seed.js";
import type { TestDb } from "../helpers/test-db.js";

// #984: start_workspace must resolve provider/profile through the shared
// Bullseye-aware resolver (`resolveProviderProfileFromPrefs`), not a hand-rolled
// `provider` + codex→claude profile ladder. These tests drive the REAL tool
// handler against an in-memory DB and assert the workspace row it records.

vi.mock("../../db.js", async () => {
  const { createTestDb } = await import("../helpers/test-db.js");
  const sharedSchema = await import("@agentic-kanban/shared/schema");
  return { db: createTestDb().db, schema: sharedSchema };
});

vi.mock("../../git-service.js", () => ({
  getCurrentBranch: vi.fn(async () => "master"),
  createWorktree: vi.fn(async () => "C:/repo/.worktrees/test"),
}));

vi.mock("../../notify.js", () => ({ notifyBoard: vi.fn() }));
vi.mock("../../setup-script.js", () => ({ runSetupScript: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })) }));

import { db } from "../../db.js";
import { registerStartWorkspace } from "../../tools/start-workspace.js";

const testDb = db as unknown as TestDb;

async function setPrefs(prefs: Record<string, string>): Promise<void> {
  const now = new Date().toISOString();
  for (const [key, value] of Object.entries(prefs)) {
    await testDb.insert(schema.preferences).values({ key, value, updatedAt: now });
  }
}

function bullseyeWith(policies: Array<Record<string, unknown>>): string {
  return JSON.stringify({ version: 1, segments: [], providerPolicies: policies });
}

async function createIssue(): Promise<{ issueId: string; projectId: string }> {
  const { projectId, statusIds } = await seedProject(testDb, `Project-${Math.random().toString(36).slice(2, 8)}`);
  const issue = await seedIssue(testDb, projectId, statusIds["Todo"]);
  return { issueId: issue.id, projectId };
}

async function invokeStartWorkspace(issueId: string) {
  const { server, getHandler } = createToolHarness();
  registerStartWorkspace(server);
  return getHandler()({ issueId, isDirect: true });
}

async function recordedWorkspace(id: string) {
  const rows = await testDb.select().from(schema.workspaces).where(eq(schema.workspaces.id, id)).limit(1);
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe("start_workspace provider/profile resolution (#984)", () => {
  beforeEach(async () => {
    await testDb.delete(schema.preferences);
  });

  it("a Bullseye pinning codex:default wins over settings prefs claude/anth", async () => {
    const { issueId, projectId } = await createIssue();
    await setPrefs({
      provider: "claude",
      claude_profile: "anth",
      [`board_strategy_${projectId}`]: bullseyeWith([
        { id: "policy-codex-default", provider: "codex", profileName: "default", label: "Codex", mode: "fill", headroomPct: 0, notes: "" },
      ]),
    });

    const result = parseResult(await invokeStartWorkspace(issueId));
    const ws = await recordedWorkspace(result.id);

    expect(ws.provider).toBe("codex");
    expect(ws.claudeProfile).toBe("default");
  });

  it("settings fallback: pi reads pi_profile, not claude_profile", async () => {
    const { issueId } = await createIssue();
    await setPrefs({ provider: "pi", pi_profile: "pi-main", claude_profile: "anth" });

    const result = parseResult(await invokeStartWorkspace(issueId));
    const ws = await recordedWorkspace(result.id);

    expect(ws.provider).toBe("pi");
    expect(ws.claudeProfile).toBe("pi-main");
  });

  it("settings fallback: copilot reads copilot_profile, not claude_profile", async () => {
    const { issueId } = await createIssue();
    await setPrefs({ provider: "copilot", copilot_profile: "cop-x", claude_profile: "anth" });

    const result = parseResult(await invokeStartWorkspace(issueId));
    const ws = await recordedWorkspace(result.id);

    expect(ws.provider).toBe("copilot");
    expect(ws.claudeProfile).toBe("cop-x");
  });

  it("malformed Bullseye JSON falls back to the settings prefs", async () => {
    const { issueId, projectId } = await createIssue();
    await setPrefs({
      provider: "claude",
      claude_profile: "anth",
      [`board_strategy_${projectId}`]: "{not json",
    });

    const result = parseResult(await invokeStartWorkspace(issueId));
    const ws = await recordedWorkspace(result.id);

    expect(ws.provider).toBe("claude");
    expect(ws.claudeProfile).toBe("anth");
  });
});
