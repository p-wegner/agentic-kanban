// @covers mcp-server.launch.workspace [api]
//
// The launch_workspace tool resolves the workspace locally, derives a default
// prompt from the issue when none is given, then DELEGATES the actual launch to
// the board REST server (POST /api/workspaces/:id/launch) and returns the
// documented success shape: { id, sessionId } (isError:false). The pre-fetch
// edge errors are covered in workspace-edge-errors.test.ts; this file covers the
// uncovered SUCCESS api contract — right endpoint, right payload, result passthrough.

import { describe, expect, it, vi, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { registerLaunchWorkspace } from "../../tools/launch-workspace.js";
import { setupTool, parseResult } from "../helpers/tool-harness.js";
import { seedIssue, seedProject } from "../helpers/seed.js";
import type { TestDb } from "../helpers/test-db.js";

async function seedLaunchableWorkspace(
  db: TestDb,
  issueTitle = "Implement the thing",
): Promise<{ workspaceId: string; projectId: string }> {
  const { projectId, statusIds } = await seedProject(db);
  const issue = await seedIssue(db, projectId, statusIds["In Progress"], { title: issueTitle });
  const workspaceId = randomUUID();
  const now = new Date().toISOString();

  await db.insert(schema.workspaces).values({
    id: workspaceId,
    issueId: issue.id,
    branch: `feature/${workspaceId}`,
    workingDir: "C:/repo/.worktrees/launchable",
    baseBranch: "main",
    isDirect: false,
    status: "idle",
    provider: "codex",
    createdAt: now,
    updatedAt: now,
  });

  return { workspaceId, projectId };
}

describe("launch_workspace delegates to the server launch path", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs /api/workspaces/:id/launch and returns the documented { id, sessionId } success shape", async () => {
    const sessionId = randomUUID();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ sessionId }), { status: 200 }),
    );

    const { invoke, db, deps } = setupTool(registerLaunchWorkspace);
    const { workspaceId, projectId } = await seedLaunchableWorkspace(db, "Implement the thing");

    const result = await invoke({ workspaceId });

    // Delegation: exactly one POST to the authoritative launch endpoint for THIS ws.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain(`/api/workspaces/${workspaceId}/launch`);
    expect(init).toMatchObject({ method: "POST" });

    // Payload contract: default prompt is derived from the issue title (no description here).
    const sentBody = JSON.parse(String((init as RequestInit).body));
    expect(sentBody).toEqual({ prompt: "Implement the thing" });

    // Success result shape: { id, sessionId }, surfaced as a non-error tool result.
    expect(result.isError ?? false).toBe(false);
    const data = parseResult(result);
    expect(data).toEqual({ id: workspaceId, sessionId });

    // Side effect: the board is notified for THIS project so the UI updates.
    expect(deps.notifyBoard).toHaveBeenCalledWith(projectId, "mcp_launch_workspace");
  });

  it("forwards an explicit prompt verbatim instead of deriving one", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ sessionId: "s-1" }), { status: 200 }),
    );

    const { invoke, db } = setupTool(registerLaunchWorkspace);
    const { workspaceId } = await seedLaunchableWorkspace(db);

    await invoke({ workspaceId, prompt: "do exactly this" });

    const [, init] = fetchSpy.mock.calls[0];
    const sentBody = JSON.parse(String((init as RequestInit).body));
    expect(sentBody).toEqual({ prompt: "do exactly this" });
  });
});
