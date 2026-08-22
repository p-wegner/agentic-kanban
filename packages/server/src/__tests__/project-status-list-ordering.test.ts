/**
 * #773 — a project's status list is read in eight places, and seven of them read it with no
 * `ORDER BY`.
 *
 * SQLite gives no ordering guarantee without one, and "no guarantee" is not the same as
 * "harmless": measured against the real board database, the unordered plan is
 * `SEARCH project_statuses USING INDEX project_statuses_project_name_unique (project_id=?)`,
 * so the rows come back in NAME order — `AI Reviewed, Backlog, Cancelled, …` — whose first
 * element is not the board's first column. #668 already shipped that exact bug once, in the
 * "which status does a new issue land in" read.
 *
 * These tests pin the invariant #773 lands: `listProjectStatusIdNames` orders by `sortOrder`
 * UNCONDITIONALLY — there is no opt-in flag any more, so a caller that omits an option gets
 * the safe behaviour. The first case also proves the ORDER BY is load-bearing rather than
 * decorative, by showing that the same query without it hands back a different order.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { projects, projectStatuses } from "@agentic-kanban/shared/schema";
import { createTestDb, ensureTestStatus, type TestDb } from "./helpers/test-db.js";
import { listProjectStatusIdNames } from "../repositories/project-status.repository.js";
import { getBoardStatusStatuses } from "../repositories/board-status.repository.js";
import {
  getProjectStatusNamesForVoiceCapture,
  getProjectStatusesForVoiceCapture,
} from "../repositories/voice-capture.repository.js";
import { getProjectStatusOptions } from "../repositories/merge-cleanup.repository.js";
import { getProjectStatusList } from "../repositories/sprint-capacity.repository.js";
import { getProjectStatusIdsAndNames } from "../repositories/project-service.repository.js";
import { getProjectStatusRows as getLaunchFailureStatusRows } from "../repositories/workspace-launch-failures.repository.js";
import { getProjectStatusRows as getRiskStatusRows } from "../repositories/workspace-risk.repository.js";

/**
 * This board's real column order. Deliberately NOT alphabetical and not insertion order:
 * sorted by name it would start with "AI Reviewed", which is what an unordered read returns.
 */
const SORT_ORDER = ["Backlog", "Todo", "In Progress", "In Review", "AI Reviewed", "Done", "Cancelled"];

let db: TestDb;
let projectId: string;

beforeAll(async () => {
  ({ db } = createTestDb());
  projectId = randomUUID();
  await db.insert(projects).values({
    id: projectId,
    name: "ordering-fixture",
    repoPath: "/tmp/ordering-fixture",
    repoName: "ordering-fixture",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  // Inserted in an order that matches NEITHER the sort order nor the alphabet, so a passing
  // assertion cannot be explained by insertion order.
  for (const name of ["In Review", "Done", "Backlog", "Cancelled", "Todo", "AI Reviewed", "In Progress"]) {
    await ensureTestStatus(db, projectId, name, { sortOrder: SORT_ORDER.indexOf(name) });
  }
});

describe("#773 project status list ordering", () => {
  it("listProjectStatusIdNames orders by sortOrder with no option passed", async () => {
    const rows = await listProjectStatusIdNames(projectId, db);
    expect(rows.map((r) => r.name)).toEqual(SORT_ORDER);
  });

  /**
   * The proof that the previous default was a real defect and not a theoretical one: the same
   * SELECT with the ORDER BY removed — i.e. exactly what the seven unordered callers ran — is
   * observably NOT in board order on this fixture. Asserted as "differs" rather than
   * "alphabetical" so the test pins the invariant instead of a particular query plan.
   */
  it("the same query WITHOUT the ORDER BY returns a different order (so the fix is load-bearing)", async () => {
    const unordered = await db
      .select({ id: projectStatuses.id, name: projectStatuses.name })
      .from(projectStatuses)
      .where(eq(projectStatuses.projectId, projectId));
    expect(unordered).toHaveLength(SORT_ORDER.length);
    expect(unordered.map((r) => r.name)).not.toEqual(SORT_ORDER);
  });

  it("the board's first status is the board's first column, not the alphabetically first one", async () => {
    const rows = await listProjectStatusIdNames(projectId, db);
    expect(rows[0].name).toBe("Backlog");
    expect(rows[0].name).not.toBe("AI Reviewed");
  });

  /**
   * Every one of the eight call sites, through its own accessor. The two order-DEPENDENT ones
   * (board columns; the voice command's substring match + the list it renders to the user) are
   * the reason this matters; the six order-independent ones are asserted too so that a future
   * "this one doesn't need it" edit shows up here rather than in production.
   */
  it("every status-list accessor returns board order", async () => {
    const accessors: Array<[string, Promise<Array<{ name: string }>>]> = [
      ["board-status", getBoardStatusStatuses(projectId, db)],
      ["voice-capture (id/name)", getProjectStatusNamesForVoiceCapture(projectId, db)],
      ["voice-capture (with isDefault)", getProjectStatusesForVoiceCapture(projectId, db)],
      ["merge-cleanup", getProjectStatusOptions(projectId, db)],
      ["sprint-capacity", getProjectStatusList(projectId, db)],
      ["project-service", getProjectStatusIdsAndNames(projectId, db)],
      ["workspace-launch-failures", getLaunchFailureStatusRows(projectId, db)],
      ["workspace-risk", getRiskStatusRows(projectId, db)],
    ];
    for (const [label, promise] of accessors) {
      expect((await promise).map((r) => r.name), label).toEqual(SORT_ORDER);
    }
  });
});
