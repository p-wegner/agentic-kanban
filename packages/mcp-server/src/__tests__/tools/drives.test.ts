import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@agentic-kanban/shared/schema";
import {
  registerStartDrive,
  registerListDrives,
  registerGetDrive,
  registerFinishDrive,
} from "../../tools/drives.js";
import { setupTool, parseResult } from "../helpers/tool-harness.js";
import { seedProject, seedIssue } from "../helpers/seed.js";

describe("drive MCP tools", () => {
  it("start_drive creates an active Drive record persisted in the DB", async () => {
    const { invoke, db, deps } = setupTool(registerStartDrive);
    const { projectId, statusIds } = await seedProject(db);
    const { id: metaIssueId } = await seedIssue(db, projectId, statusIds["In Progress"]);

    const data = parseResult(await invoke({
      projectId,
      target: "Ship the timetracker epic to master",
      metaIssueId,
      completionContract: "All children Done AND master contains the work",
    }));

    expect(data.id).toBeTruthy();
    expect(data.projectId).toBe(projectId);
    expect(data.metaIssueId).toBe(metaIssueId);
    expect(data.target).toBe("Ship the timetracker epic to master");
    expect(data.status).toBe("active");
    expect(data.startedAt).toBeTruthy();
    expect(data.finishedAt).toBeNull();

    // Persisted (survives — readable straight from the table)
    const rows = await db.select().from(schema.drives).where(eq(schema.drives.id, data.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("active");
    expect(deps.notifyBoard).toHaveBeenCalledWith(projectId, "drive_started");
  });

  it("start_drive requires a target and a real project", async () => {
    const { invoke, db } = setupTool(registerStartDrive);
    const { projectId } = await seedProject(db);

    const noTarget = await invoke({ projectId, target: "   " });
    expect(noTarget.content[0].text).toContain("target is required");

    const badProject = await invoke({ projectId: "nope", target: "x" });
    expect(badProject.content[0].text).toContain("not found");
  });

  it("list_drives and get_drive query drive state", async () => {
    const { invoke: start, db, deps } = setupTool(registerStartDrive);
    const { projectId } = await seedProject(db);
    const a = parseResult(await start({ projectId, target: "Drive A" }));
    parseResult(await start({ projectId, target: "Drive B" }));

    const { invoke: list } = setupTool(registerListDrives, { db, notifyBoard: deps.notifyBoard });
    const all = parseResult(await list({ projectId }));
    expect(all).toHaveLength(2);
    const targets = all.map((d: { target: string }) => d.target);
    expect(targets).toContain("Drive A");
    expect(targets).toContain("Drive B");

    const { invoke: get } = setupTool(registerGetDrive, { db });
    const one = parseResult(await get({ driveId: a.id }));
    expect(one.id).toBe(a.id);
    expect(one.target).toBe("Drive A");

    const missing = await get({ driveId: "nope" });
    expect(missing.content[0].text).toContain("not found");
  });

  it("list_drives filters by status", async () => {
    const { invoke: start, db } = setupTool(registerStartDrive);
    const { projectId } = await seedProject(db);
    const a = parseResult(await start({ projectId, target: "Drive A" }));
    parseResult(await start({ projectId, target: "Drive B" }));

    const { invoke: finish } = setupTool(registerFinishDrive, { db });
    await finish({ driveId: a.id });

    const { invoke: list } = setupTool(registerListDrives, { db });
    const active = parseResult(await list({ projectId, status: "active" }));
    expect(active).toHaveLength(1);
    expect(active[0].target).toBe("Drive B");

    const completed = parseResult(await list({ projectId, status: "completed" }));
    expect(completed).toHaveLength(1);
    expect(completed[0].target).toBe("Drive A");
  });

  it("finish_drive sets a terminal status and stamps finishedAt", async () => {
    const { invoke: start, db, deps } = setupTool(registerStartDrive);
    const { projectId } = await seedProject(db);
    const a = parseResult(await start({ projectId, target: "Drive A" }));

    const { invoke: finish } = setupTool(registerFinishDrive, { db, notifyBoard: deps.notifyBoard });
    const done = parseResult(await finish({ driveId: a.id }));
    expect(done.status).toBe("completed");
    expect(done.finishedAt).toBeTruthy();

    const rows = await db.select().from(schema.drives).where(eq(schema.drives.id, a.id));
    expect(rows[0].status).toBe("completed");
    expect(rows[0].finishedAt).toBeTruthy();
    expect(deps.notifyBoard).toHaveBeenCalledWith(projectId, "drive_finished");

    const abandoned = parseResult(await finish({ driveId: a.id, status: "abandoned" }));
    expect(abandoned.status).toBe("abandoned");
  });
});
