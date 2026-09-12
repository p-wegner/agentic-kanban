/**
 * #1108: a quiesced project holds workspace creation AND relaunch, regardless of Start
 * Mode — `manual` deliberately still permits explicit relaunch, quiesce does not.
 * Both refusals happen BEFORE any git/worktree work (the assertion sits at the top of
 * `createWorkspace`/`launchSession`), so this suite never touches a real repo and stays fast.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { setPreference } from "../repositories/preferences.repository.js";
import {
  createTestApp,
  createProjectDirectly,
  createStatusDirectly,
} from "./helpers/api-test-helpers.js";

describe("project quiesce holds create + relaunch (#1108)", () => {
  const { app, db: database } = createTestApp();
  let projectId: string;
  let statusId: string;

  beforeAll(async () => {
    projectId = await createProjectDirectly(database, { name: "Quiesce Project" });
    statusId = await createStatusDirectly(database, projectId, "Todo", 0);
    await createStatusDirectly(database, projectId, "In Progress", 1);
  });

  async function createIssue(title: string): Promise<string> {
    const res = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, statusId, projectId }),
    });
    const body = await res.json() as { id: string };
    return body.id;
  }

  it("refuses POST /api/workspaces while the project is quiesced", async () => {
    await setPreference(`project_quiesced_${projectId}`, "true", database);
    await setPreference(`project_quiesce_reason_${projectId}`, "promoting master", database);

    const issueId = await createIssue("held for maintenance");
    const res = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId }),
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = await res.json() as { error?: string; code?: string };
    expect(body.error).toContain("quiesced");
    expect(body.error).toContain("promoting master");
    // #1108: the specific refusal reason must survive to the response body's `code` field
    // (not just fold into the generic "CONFLICT" status code) — a caller like the UI banner
    // or `pnpm promote` needs to branch on this, not string-match the prose message.
    expect(body.code).toBe("PROJECT_QUIESCED");

    await setPreference(`project_quiesced_${projectId}`, "false", database);
  });

  it("allows POST /api/workspaces again once quiesce is cleared", async () => {
    const issueId = await createIssue("proceeds once cleared");
    const res = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId }),
    });
    expect(res.status).toBe(201);
  });

  it("refuses POST /api/workspaces/:id/launch (relaunch) while quiesced, even though Start Mode is 'manual'", async () => {
    // `start_mode=manual` is documented to still permit explicit relaunch — quiesce must
    // hold anyway, since it is the actual maintenance-window stop.
    await setPreference(`start_mode_${projectId}`, "manual", database);

    const issueId = await createIssue("stoppable then relaunched");
    const createRes = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueId }),
    });
    expect(createRes.status).toBe(201);
    const { id: workspaceId } = await createRes.json() as { id: string };

    await app.request(`/api/workspaces/${workspaceId}/stop`, { method: "POST" });

    await setPreference(`project_quiesced_${projectId}`, "true", database);
    const launchRes = await app.request(`/api/workspaces/${workspaceId}/launch`, { method: "POST" });
    expect(launchRes.status).toBeGreaterThanOrEqual(400);
    const body = await launchRes.json() as { error?: string };
    expect(body.error).toContain("quiesced");

    await setPreference(`project_quiesced_${projectId}`, "false", database);
  });
});
