import { describe, expect, it, vi, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { registerGetWorkspaceDiff } from "../../tools/get-workspace-diff.js";
import { registerMergeWorkspace } from "../../tools/merge-workspace.js";
import { registerRelaunchWorkspace } from "../../tools/relaunch-workspace.js";
import { setupTool, parseResult } from "../helpers/tool-harness.js";
import { seedIssue, seedProject } from "../helpers/seed.js";
import type { TestDb } from "../helpers/test-db.js";

type RegisterTool = Parameters<typeof setupTool>[0];

const tools: Array<{
  name: string;
  register: RegisterTool;
  args: (workspaceId: string) => Record<string, unknown>;
}> = [
  {
    name: "get_workspace_diff",
    register: registerGetWorkspaceDiff,
    args: (workspaceId) => ({ workspaceId }),
  },
  {
    name: "merge_workspace",
    register: registerMergeWorkspace,
    args: (workspaceId) => ({ workspaceId }),
  },
  {
    name: "relaunch_workspace",
    register: registerRelaunchWorkspace,
    args: (workspaceId) => ({ workspaceId, prompt: "continue" }),
  },
];

async function seedWorkspace(
  db: TestDb,
  opts: { status: "active" | "idle" | "closed"; workingDir: string | null; isDirect?: boolean },
): Promise<string> {
  const { projectId, statusIds } = await seedProject(db);
  const issue = await seedIssue(db, projectId, statusIds["In Progress"]);
  const workspaceId = randomUUID();
  const now = new Date().toISOString();

  await db.insert(schema.workspaces).values({
    id: workspaceId,
    issueId: issue.id,
    branch: `feature/${workspaceId}`,
    workingDir: opts.workingDir,
    baseBranch: "main",
    isDirect: opts.isDirect ?? false,
    status: opts.status,
    provider: "codex",
    createdAt: now,
    updatedAt: now,
  });

  return workspaceId;
}

function expectStructuredError(result: unknown, code: string, message: string, workspaceId: string) {
  const data = parseResult(result as { content: { type: string; text: string }[] });
  expect(data.error).toMatchObject({ code, message, workspaceId });
}

describe("workspace tool edge errors", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(tools)("$name returns a structured error when the workspace is missing", async ({ register, args }) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { invoke, deps } = setupTool(register);
    const workspaceId = "missing-workspace";

    const result = await invoke(args(workspaceId));

    expectStructuredError(result, "WORKSPACE_NOT_FOUND", "Workspace not found", workspaceId);
    expect(deps.getDiff).not.toHaveBeenCalled();
    expect(deps.getDiffShortstat).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(tools)("$name returns a structured error when the workspace is closed", async ({ register, args }) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { invoke, db, deps } = setupTool(register);
    const workspaceId = await seedWorkspace(db, { status: "closed", workingDir: "C:/repo/.worktrees/closed" });

    const result = await invoke(args(workspaceId));

    expectStructuredError(result, "WORKSPACE_CLOSED", "Workspace is closed", workspaceId);
    expect(deps.getDiff).not.toHaveBeenCalled();
    expect(deps.getDiffShortstat).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(tools)("$name returns a structured error when the workspace has no workingDir", async ({ register, args }) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { invoke, db, deps } = setupTool(register);
    const workspaceId = await seedWorkspace(db, { status: "idle", workingDir: "" });

    const result = await invoke(args(workspaceId));

    expectStructuredError(result, "WORKSPACE_WORKING_DIR_MISSING", "Workspace has no working directory", workspaceId);
    expect(deps.getDiff).not.toHaveBeenCalled();
    expect(deps.getDiffShortstat).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("relaunch_workspace returns a structured error for non-idle workspaces before launch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { invoke, db } = setupTool(registerRelaunchWorkspace);
    const workspaceId = await seedWorkspace(db, { status: "active", workingDir: "C:/repo/.worktrees/active" });

    const result = await invoke({ workspaceId, prompt: "continue" });

    expectStructuredError(result, "WORKSPACE_NOT_IDLE", "Workspace must be idle before relaunch", workspaceId);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
