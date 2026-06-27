// @covers workflow-engine.crud.template [boundary]
import { describe, expect, it } from "vitest";
import { createWorkflowService } from "../services/workflow.service.js";
import { createTestDb } from "./helpers/test-db.js";
import type { TestDb } from "./helpers/test-db.js";
import { seedProject } from "./helpers/workflow-test-helpers.js";

function createService(db: TestDb) {
  return createWorkflowService({ database: db });
}

/**
 * Boundary: the empty-node DRAFT create affordance.
 *
 * `createTemplate` (workflow.service.ts:210) and the shared `createWorkflowTemplate`
 * (templates.ts:125) deliberately SKIP graph validation when `nodes.length === 0`,
 * so the visual builder can persist a blank draft (no start node, resolving to a
 * null start) before the operator wires up stages. This is the boundary case the
 * happy-path CRUD tests in workflow.service.test.ts never exercise — they all create
 * a well-formed start->end graph.
 *
 * Mutation check: if the `&& srcNodes.length > 0` guard at workflow.service.ts:210
 * were removed (i.e. an empty graph were validated like any other), `validateGraph`
 * would reject the zero-node graph ("exactly one start" / ">=1 end" missing) and the
 * draft create would return `{ error: "Invalid workflow graph" }` instead of `{ data }`,
 * turning the first test RED. The second test (a NON-empty malformed graph IS rejected)
 * pins the other side of the boundary so the first can't pass by validation being
 * globally disabled.
 */
describe("workflow.service — template CRUD boundary (empty-node draft)", () => {
  it("accepts an empty-node draft template (validation skipped at the zero-node boundary)", async () => {
    const { db } = createTestDb();
    const service = createService(db);
    const { projectId } = await seedProject(db, "draft-boundary");

    const result = await service.createTemplate({
      projectId,
      name: "Blank Draft",
      nodes: [],
      edges: [],
    });

    // The draft is persisted, NOT rejected as an invalid (start-less) graph.
    expect("error" in result).toBe(false);
    expect("data" in result).toBe(true);
    if ("data" in result) {
      expect(result.data.name).toBe("Blank Draft");
      expect(result.data.isBuiltin).toBe(false);
      expect(result.data.nodes).toHaveLength(0);
      expect(result.data.edges).toHaveLength(0);
    }
  });

  it("still rejects a NON-empty malformed graph (validation only skipped at zero nodes)", async () => {
    const { db } = createTestDb();
    const service = createService(db);
    const { projectId } = await seedProject(db, "draft-boundary-neg");

    // One lone 'normal' node: no start, no end, unreachable — a malformed graph.
    const result = await service.createTemplate({
      projectId,
      name: "Malformed",
      nodes: [{ id: "n", name: "Lonely", nodeType: "normal" }],
      edges: [],
    });

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBe("Invalid workflow graph");
      expect(result.errors?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
