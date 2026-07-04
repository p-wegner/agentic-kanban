// #1001: a Codex fork-child reviewer, unable to reach mark_ready_for_merge over
// MCP, fell back to writing ready_for_merge=1 straight into kanban.db. Fork
// children must never mark ANY workspace ready for merge — their verdicts flow
// through join consolidation (propose_transition toward the join), not this
// tool. This guards the MCP tool itself so the rule holds even if a caller
// reaches it directly (defense-in-depth beyond the prompt-level guardrail).
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import { createToolHarness, parseResult } from "../helpers/tool-harness.js";
import { seedProject, seedIssue } from "../helpers/seed.js";
import type { TestDb } from "../helpers/test-db.js";

vi.mock("../../db.js", async () => {
  const { createTestDb } = await import("../helpers/test-db.js");
  const sharedSchema = await import("@agentic-kanban/shared/schema");
  return { db: createTestDb().db, schema: sharedSchema };
});

vi.mock("../../notify.js", () => ({ notifyBoard: vi.fn() }));

import { db } from "../../db.js";
import { registerMarkReadyForMerge } from "../../tools/mark-ready-for-merge.js";

const testDb = db as unknown as TestDb;

async function seedWorkspace(
  issueId: string,
  overrides: Partial<{ parentWorkspaceId: string | null }> = {},
): Promise<string> {
  const now = new Date().toISOString();
  const workspaceId = randomUUID();
  await testDb.insert(schema.workspaces).values({
    id: workspaceId,
    issueId,
    branch: "feature/ak-1001-test",
    workingDir: "/repo/.worktrees/feature_ak-1001-test",
    baseBranch: "master",
    isDirect: false,
    status: "idle",
    readyForMerge: false,
    provider: "claude",
    parentWorkspaceId: overrides.parentWorkspaceId ?? null,
    createdAt: now,
    updatedAt: now,
  });
  return workspaceId;
}

function invoke() {
  const { server, getHandler } = createToolHarness();
  registerMarkReadyForMerge(server);
  return getHandler();
}

describe("mark_ready_for_merge — fork-child guard (#1001)", () => {
  it("rejects a fork-child workspace (parentWorkspaceId set) and does not flip readyForMerge", async () => {
    const { projectId, statusIds } = await seedProject(testDb);
    const { id: issueId } = await seedIssue(testDb, projectId, statusIds["In Review"]);
    const parentId = await seedWorkspace(issueId);
    const childId = await seedWorkspace(issueId, { parentWorkspaceId: parentId });

    const result = await invoke()({ workspaceId: childId });
    const parsed = parseResult(result);

    expect(parsed.error).toBeDefined();
    expect(parsed.error.code).toBe("FORK_CHILD_CANNOT_MARK_READY");

    const rows = await testDb.select().from(schema.workspaces).where(eq(schema.workspaces.id, childId)).limit(1);
    expect(rows[0].readyForMerge).toBeFalsy();
  });

  it("still allows a normal (non-fork-child) workspace to be marked ready", async () => {
    const { projectId, statusIds } = await seedProject(testDb);
    const { id: issueId } = await seedIssue(testDb, projectId, statusIds["In Review"]);
    const workspaceId = await seedWorkspace(issueId);

    const result = await invoke()({ workspaceId });
    const parsed = parseResult(result);

    expect(parsed.error).toBeUndefined();
    expect(parsed.readyForMerge).toBe(true);

    const rows = await testDb.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).limit(1);
    expect(rows[0].readyForMerge).toBeTruthy();
  });
});
