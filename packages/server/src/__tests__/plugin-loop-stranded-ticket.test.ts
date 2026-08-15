import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { pluginLoopUnitKey } from "@agentic-kanban/shared/lib/plugin-manifest";
import { createTestDb, type TestDb } from "./helpers/test-db.js";
import { seedProject, seedIssue, seedWorkspace } from "./helpers/workflow-test-helpers.js";
import { createPluginService } from "../services/plugin.service.js";
import type { Database } from "../db/index.js";

/**
 * #413/#397 — the PHANTOM open ticket.
 *
 * MEASURED on roomsync: issue #7 ("PM pipeline 6/9") finished, merged, was approved, its
 * workspace closed — and the issue then regressed BACKWARDS onto the workflow's start node
 * and sat In Progress forever. The loop pane read `openTickets: 1` and told the operator
 * "Round in progress — the next round is planned automatically once they close", while all
 * 9 step chips showed ✓, the API said `converged: true`, and the loop's own status script
 * printed "pipeline complete". Three statements, one screen, mutually exclusive.
 *
 * The surface must therefore distinguish three open-ticket shapes:
 *   - live      — a workspace is running it (a genuine round in progress),
 *   - queued    — planned, no workspace yet (the monitor will provision it),
 *   - stranded  — HAS had a workspace, none live (nothing will ever close it).
 * Only the third is a phantom, and conflating it with `queued` would fire the warning on
 * every freshly planned round.
 */

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const MANIFEST = {
  id: "stranded-probe",
  name: "Stranded Probe",
  skills: [{ dir: "skills/analysis" }],
  loops: [{ name: "pipeline", skill: "analysis", plan: { command: "exit 1", cwd: "plugin" } }],
};

function makePluginDir(): string {
  const dir = makeTempDir("stranded-plugin-");
  writeFileSync(join(dir, "kanban-plugin.json"), JSON.stringify(MANIFEST, null, 2));
  const skillDir = join(dir, "skills", "analysis");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# analysis");
  return dir;
}

async function loopSurface(db: TestDb, projectId: string) {
  const service = createPluginService({ database: db as unknown as Database });
  const plugin = await service.installPlugin({ source: makePluginDir() });
  const [loop] = await service.listLoops(plugin.id, projectId);
  return loop;
}

function unit(id: string): string {
  return pluginLoopUnitKey("stranded-probe", "pipeline", id);
}

describe("plugin loop — stranded open ticket (#413)", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows file locks — best-effort cleanup */
      }
    }
  });

  it("flags an open ticket whose only workspace is closed", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db, "Stranded Project");
    const issueId = await seedIssue(db, projectId, statusId, 7, "PM pipeline 6/9", { externalKey: unit("step-6") });
    const workspaceId = await seedWorkspace(db, issueId, "feature/ak-7-step-6", null);
    await db.update(schema.workspaces).set({ status: "closed" }).where(eq(schema.workspaces.id, workspaceId));

    const loop = await loopSurface(db, projectId);

    expect(loop.openTickets).toBe(1);
    expect(loop.openTicketRefs).toEqual([
      { issueId, issueNumber: 7, statusName: expect.any(String), stranded: true },
    ]);
  });

  it("flags an open ticket whose workspace exited idle with no commits (#479)", async () => {
    // The measured shape: the agent exited, the workspace never closes on its own (it sits at
    // `idle`), and there are zero commits. `status != 'closed'` used to call this "live" — the
    // exact false negative #479 reported (`stranded: false` on a workspace nothing is driving).
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db, "Idle No-Commit Project");
    const issueId = await seedIssue(db, projectId, statusId, 11, "PM pipeline step 1", { externalKey: unit("step-1") });
    const workspaceId = await seedWorkspace(db, issueId, "feature/ak-11-step-1", null);
    await db.update(schema.workspaces).set({ status: "idle" }).where(eq(schema.workspaces.id, workspaceId));

    const loop = await loopSurface(db, projectId);

    expect(loop.openTicketRefs).toEqual([
      { issueId, issueNumber: 11, statusName: expect.any(String), stranded: true },
    ]);
  });

  it("does NOT flag a ticket a live workspace is still working", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db, "Live Project");
    const issueId = await seedIssue(db, projectId, statusId, 8, "PM pipeline 7/9", { externalKey: unit("step-7") });
    await seedWorkspace(db, issueId, "feature/ak-8-step-7", null); // seeded `active`

    const loop = await loopSurface(db, projectId);

    expect(loop.openTicketRefs).toEqual([{ issueId, issueNumber: 8, statusName: expect.any(String), stranded: false }]);
  });

  it("does NOT flag a freshly planned ticket that has no workspace yet", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db, "Queued Project");
    // The shape of EVERY round the moment it is planned: the monitor provisions it within
    // the project's WIP limit. Flagging this would make the warning permanent noise.
    const issueId = await seedIssue(db, projectId, statusId, 9, "PM pipeline 8/9", { externalKey: unit("step-8") });

    const loop = await loopSurface(db, projectId);

    expect(loop.openTicketRefs).toEqual([{ issueId, issueNumber: 9, statusName: expect.any(String), stranded: false }]);
  });

  it("a closed workspace does not strand a ticket that ALSO has a live one", async () => {
    const { db } = createTestDb();
    const { projectId, statusId } = await seedProject(db, "Relaunched Project");
    // A relaunched unit: the first attempt was closed, the second is running. Reading
    // "has a closed workspace" alone — rather than "has NO live workspace" — would call
    // this a phantom while an agent is actively working it.
    const issueId = await seedIssue(db, projectId, statusId, 10, "PM pipeline 9/9", { externalKey: unit("step-9") });
    const deadId = await seedWorkspace(db, issueId, "feature/ak-10-a", null);
    await db.update(schema.workspaces).set({ status: "closed" }).where(eq(schema.workspaces.id, deadId));
    await seedWorkspace(db, issueId, "feature/ak-10-b", null);

    const loop = await loopSurface(db, projectId);

    expect(loop.openTicketRefs[0].stranded).toBe(false);
  });
});
