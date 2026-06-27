// @covers mcp-server.merge.workspace.delegate [api,risk]
//
// The merge_workspace tool fast-fails obviously-invalid calls locally, then
// DELEGATES the authoritative merge to the board REST server
// (POST /api/workspaces/:id/merge) and passes the server's result back to the
// agent unchanged. The pre-fetch error paths are already covered in
// workspace-edge-errors.test.ts; this file covers the uncovered SUCCESS
// delegation + server-result passthrough (api/risk dimensions): that a valid
// merge actually POSTs the right URL and that a delegated failure (e.g. 409
// lock / 503 verify-fail / conflict) is surfaced as an error result, not a crash.

import { describe, expect, it, vi, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { registerMergeWorkspace } from "../../tools/merge-workspace.js";
import { setupTool } from "../helpers/tool-harness.js";
import { seedIssue, seedProject } from "../helpers/seed.js";
import type { TestDb } from "../helpers/test-db.js";

async function seedMergeableWorkspace(db: TestDb): Promise<string> {
  const { projectId, statusIds } = await seedProject(db);
  const issue = await seedIssue(db, projectId, statusIds["In Progress"]);
  const workspaceId = randomUUID();
  const now = new Date().toISOString();

  await db.insert(schema.workspaces).values({
    id: workspaceId,
    issueId: issue.id,
    branch: `feature/${workspaceId}`,
    workingDir: "C:/repo/.worktrees/mergeable",
    baseBranch: "main",
    isDirect: false,
    status: "idle",
    provider: "codex",
    createdAt: now,
    updatedAt: now,
  });

  return workspaceId;
}

describe("merge_workspace delegates to the server merge path", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs /api/workspaces/:id/merge and passes the server's success result through", async () => {
    const serverBody = JSON.stringify({ merged: true, issueStatus: "Done" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(serverBody, { status: 200 }),
    );

    const { invoke, db } = setupTool(registerMergeWorkspace);
    const workspaceId = await seedMergeableWorkspace(db);

    const result = await invoke({ workspaceId });

    // Delegation: exactly one POST to the authoritative merge endpoint for THIS ws.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain(`/api/workspaces/${workspaceId}/merge`);
    expect(init).toMatchObject({ method: "POST" });

    // Passthrough: the server's body is forwarded verbatim to the agent.
    expect(result.content[0].text).toBe(serverBody);
  });

  it("surfaces a delegated failure (e.g. 409 merge-in-progress) as an error result, not a crash", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("merge already in progress for this repo", { status: 409 }),
    );

    const { invoke, db } = setupTool(registerMergeWorkspace);
    const workspaceId = await seedMergeableWorkspace(db);

    const result = await invoke({ workspaceId });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const text = result.content[0].text;
    expect(text).toContain("409");
    expect(text).toContain("merge already in progress");
    // Distinct from a successful passthrough: the failure is framed, not silent.
    expect(text).toMatch(/not completed/i);
  });
});
