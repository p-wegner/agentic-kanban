import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import * as schema from "@agentic-kanban/shared/schema";
import { registerListMergeTrains, registerGetMergeTrain } from "../../tools/merge-trains.js";
import { setupTool, parseResult } from "../helpers/tool-harness.js";
import { seedProject } from "../helpers/seed.js";
import type { TestDb } from "../helpers/test-db.js";

/**
 * #1195 — the two DB-reading train tools. `cancel_merge_train` and `release_train_window`
 * delegate to the board's REST routes over HTTP (the #605 rule for state the server owns) and
 * are covered by the route tests on the server side.
 */
async function seedTrain(
  db: TestDb,
  projectId: string,
  over: Partial<typeof schema.mergeTrains.$inferInsert> = {},
): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.mergeTrains).values({
    id,
    projectId,
    label: `q${id.slice(0, 6)}`,
    memberWorkspaceIds: JSON.stringify(["ws-a", "ws-b"]),
    state: "assembling",
    ...over,
  });
  return id;
}

describe("merge-train MCP tools (#1195)", () => {
  it("list_merge_trains lists a project's trains newest first and filters by state", async () => {
    const { invoke, db } = setupTool(registerListMergeTrains);
    const { projectId } = await seedProject(db);
    const older = await seedTrain(db, projectId, { state: "landed", startedAt: "2026-09-01T10:00:00.000Z" });
    const newer = await seedTrain(db, projectId, { state: "gating", startedAt: "2026-09-02T10:00:00.000Z" });

    const all = parseResult(await invoke({ projectId }));
    expect(all.map((t: { id: string }) => t.id)).toEqual([newer, older]);

    const gating = parseResult(await invoke({ projectId, state: "gating" }));
    expect(gating).toHaveLength(1);
    expect(gating[0].id).toBe(newer);

    const otherProject = parseResult(await invoke({ projectId: "nope" }));
    expect(otherProject).toEqual([]);
  });

  it("get_merge_train parses the evidence and lifts the bisect-tree attempts to the top level", async () => {
    const { invoke, db } = setupTool(registerGetMergeTrain);
    const { projectId } = await seedProject(db);
    const id = await seedTrain(db, projectId, {
      state: "red",
      gateEvidence: JSON.stringify({ gateRuns: 2, dropped: ["ws-b"], attempts: [{ n: 1 }, { n: 2 }] }),
      bisectResult: JSON.stringify({ culprits: ["ws-b"] }),
    });

    const train = parseResult(await invoke({ id }));
    expect(train.id).toBe(id);
    expect(train.state).toBe("red");
    expect(train.gateEvidence).toMatchObject({ gateRuns: 2, dropped: ["ws-b"] });
    expect(train.bisectResult).toEqual({ culprits: ["ws-b"] });
    expect(train.attempts).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("get_merge_train answers an empty attempts list without evidence, and a not-found error for an unknown id", async () => {
    const { invoke, db } = setupTool(registerGetMergeTrain);
    const { projectId } = await seedProject(db);
    const id = await seedTrain(db, projectId);

    const fresh = parseResult(await invoke({ id }));
    expect(fresh.gateEvidence).toBeNull();
    expect(fresh.attempts).toEqual([]);

    const missing = await invoke({ id: "nope" });
    expect(missing.content[0].text).toContain("not found");
  });
});
