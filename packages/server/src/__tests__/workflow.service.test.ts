import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowService } from "../services/workflow.service.js";
import { createTestDb } from "./helpers/test-db.js";
import type { TestDb } from "./helpers/test-db.js";
import * as schema from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { seedProject, seedIssue, seedWorkspace, seedLinearWorkflow } from "./helpers/workflow-test-helpers.js";

function createService(db: TestDb) {
  return createWorkflowService({ database: db });
}

describe("workflow.service — template CRUD", () => {
  it("creates a template with a valid graph", async () => {
    const { db } = createTestDb();
    const service = createService(db);
    const { projectId } = await seedProject(db, "tpl-crud");

    const result = await service.createTemplate({
      projectId,
      name: "My Workflow",
      nodes: [
        { id: "s", name: "Start", nodeType: "start" },
        { id: "e", name: "End", nodeType: "end" },
      ],
      edges: [
        { fromNodeId: "s", toNodeId: "e" },
      ],
    });

    expect("error" in result).toBe(false);
    if ("data" in result) {
      expect(result.data.name).toBe("My Workflow");
      expect(result.data.nodes).toHaveLength(2);
      expect(result.data.edges).toHaveLength(1);
    }
  });

  it("rejects creation without projectId", async () => {
    const { db } = createTestDb();
    const service = createService(db);

    const result = await service.createTemplate({ projectId: "" });
    expect(result.error).toBe("projectId is required");
  });

  it("rejects creation without name", async () => {
    const { db } = createTestDb();
    const service = createService(db);
    const { projectId } = await seedProject(db, "no-name");

    const result = await service.createTemplate({ projectId });
    expect(result.error).toBe("name is required");
  });

  it("clones a template", async () => {
    const { db } = createTestDb();
    const service = createService(db);
    const { projectId } = await seedProject(db, "clone");

    const original = await service.createTemplate({
      projectId,
      name: "Original",
      nodes: [
        { id: "s", name: "Start", nodeType: "start" },
        { id: "e", name: "End", nodeType: "end" },
      ],
      edges: [{ fromNodeId: "s", toNodeId: "e" }],
    });
    const originalId = ("data" in original) ? original.data.id : "";

    const cloned = await service.createTemplate({
      projectId,
      cloneFrom: originalId,
    });

    expect("error" in cloned).toBe(false);
    if ("data" in cloned) {
      expect(cloned.data.name).toBe("Original (copy)");
      expect(cloned.data.id).not.toBe(originalId);
      expect(cloned.data.nodes).toHaveLength(2);
    }
  });

  it("deletes a non-builtin template with cascade", async () => {
    const { db } = createTestDb();
    const service = createService(db);
    const { projectId } = await seedProject(db, "delete");

    const created = await service.createTemplate({
      projectId,
      name: "ToDelete",
      nodes: [
        { id: "s", name: "Start", nodeType: "start" },
        { id: "e", name: "End", nodeType: "end" },
      ],
      edges: [{ fromNodeId: "s", toNodeId: "e" }],
    });
    const id = ("data" in created) ? created.data.id : "";

    const result = await service.deleteTemplate(id);
    expect(result.ok).toBe(true);

    // Verify cascaded
    const nodes = await db.select().from(schema.workflowNodes).where(eq(schema.workflowNodes.templateId, id));
    expect(nodes).toHaveLength(0);
  });

  it("rejects deletion of builtin templates", async () => {
    const { db } = createTestDb();
    const service = createService(db);
    const id = randomUUID();
    await db.insert(schema.workflowTemplates).values({
      id, projectId: null, name: "Built-in", isDefault: true, isBuiltin: true,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const result = await service.deleteTemplate(id);
    expect(result.error).toBe("Built-in workflows cannot be deleted.");
  });

  it("updates a non-builtin template", async () => {
    const { db } = createTestDb();
    const service = createService(db);
    const { projectId } = await seedProject(db, "update");

    const created = await service.createTemplate({
      projectId,
      name: "Before",
      nodes: [
        { id: "s", name: "Start", nodeType: "start" },
        { id: "e", name: "End", nodeType: "end" },
      ],
      edges: [{ fromNodeId: "s", toNodeId: "e" }],
    });
    expect("data" in created).toBe(true);
    const id = ("data" in created) ? created.data.id : "";

    const result = await service.updateTemplate(id, { name: "After" });
    expect("data" in result).toBe(true);
    if ("data" in result) {
      expect(result.data.name).toBe("After");
      expect(result.data.nodes).toHaveLength(2);
      expect(result.data.edges).toHaveLength(1);
    }
  });

  it("rejects update of builtin template", async () => {
    const { db } = createTestDb();
    const service = createService(db);
    const id = randomUUID();
    await db.insert(schema.workflowTemplates).values({
      id, projectId: null, name: "Built-in", isDefault: true, isBuiltin: true,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const result = await service.updateTemplate(id, { name: "Hacked" });
    expect(result.error).toContain("Built-in workflows cannot be edited");
  });
});

describe("workflow.service — import/export", () => {
  it("exports a template as a JSON envelope", async () => {
    const { db } = createTestDb();
    const service = createService(db);
    const { projectId } = await seedProject(db, "export");

    const created = await service.createTemplate({
      projectId,
      name: "Exportable",
      nodes: [{ id: "s", name: "Start", nodeType: "start" }],
      edges: [],
    });
    const id = ("data" in created) ? created.data.id : "";

    const result = await service.exportTemplate(id);
    if ("data" in result) {
      expect(result.data.version).toBe(1);
      expect(result.data.metadata.name).toBe("Exportable");
      expect(result.data.nodes).toHaveLength(1);
    }
  });

  it("imports a template from a JSON envelope", async () => {
    const { db } = createTestDb();
    const service = createService(db);
    const { projectId } = await seedProject(db, "import");

    const result = await service.importTemplate({
      projectId,
      raw: {
        name: "Imported",
        nodes: [
          { id: "s", name: "Start", nodeType: "start" },
          { id: "e", name: "End", nodeType: "end" },
        ],
        edges: [{ fromNodeId: "s", toNodeId: "e" }],
      },
    });

    expect("error" in result).toBe(false);
    if ("data" in result) {
      expect(result.data.name).toBe("Imported");
      expect(result.data.nodes).toHaveLength(2);
    }
  });

  it("rejects import with missing name", async () => {
    const { db } = createTestDb();
    const service = createService(db);
    const { projectId } = await seedProject(db, "import-bad");

    const result = await service.importTemplate({
      projectId,
      raw: { nodes: [], edges: [] },
    });
    expect(result.error).toBe("Invalid workflow import");
    if (result.errors) expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe("workflow.service — template listing", () => {
  it("lists templates with optional graph embedding", async () => {
    const { db } = createTestDb();
    const service = createService(db);
    const { projectId } = await seedProject(db, "list");

    await service.createTemplate({
      projectId,
      name: "With Graph",
      nodes: [
        { id: "s", name: "Start", nodeType: "start" },
        { id: "e", name: "End", nodeType: "end" },
      ],
      edges: [{ fromNodeId: "s", toNodeId: "e" }],
    });

    const flat = await service.listTemplates({ projectId });
    expect(flat.length).toBeGreaterThanOrEqual(1);
    const flatItem = flat.find((t: any) => t.name === "With Graph");
    expect(flatItem).toBeTruthy();
    expect((flatItem as any).nodes).toBeUndefined();

    const withGraph = await service.listTemplates({ projectId, withGraph: true });
    const graphItem = withGraph.find((t: any) => t.name === "With Graph");
    expect((graphItem as any).nodes).toHaveLength(2);
  });
});

describe("workflow.service — analytics", () => {
  it("computes per-node visit counts and dwell", async () => {
    const { db } = createTestDb();
    const service = createService(db);
    const { projectId, statusId } = await seedProject(db, "analytics-visits");
    const { templateId, nodeIds } = await seedLinearWorkflow(db, ["Start", "Build", "Done"]);
    const [startId, buildId] = nodeIds;

    const issueId = await seedIssue(db, projectId, statusId, 1, "Analytics issue");
    const wsId = await seedWorkspace(db, issueId, "feature/analytics", buildId);

    await db.insert(schema.workflowTransitions).values([
      { id: randomUUID(), workspaceId: wsId, fromNodeId: null, toNodeId: startId, createdAt: "2026-05-30T10:00:00.000Z", triggeredBy: "system" },
      { id: randomUUID(), workspaceId: wsId, fromNodeId: startId, toNodeId: buildId, createdAt: "2026-05-30T10:10:00.000Z", triggeredBy: "manual" },
    ]);

    const result = await service.getAnalytics(projectId);
    const buildNode = result.nodes.find((n: any) => n.nodeId === buildId);
    expect(buildNode).toMatchObject({
      nodeName: "Build",
      visits: 1,
      dropoff: 1,
    });
    expect(result.totalWorkspaces).toBe(1);
  });
});

describe("workflow.service — resolve", () => {
  it("resolves template by issueId", async () => {
    const { db } = createTestDb();
    const service = createService(db);
    const { projectId, statusId } = await seedProject(db, "resolve");
    const { templateId } = await seedLinearWorkflow(db, ["Start", "End"]);

    const issueId = await seedIssue(db, projectId, statusId, 1, "Resolve test", {
      workflowTemplateId: templateId,
    });

    const result = await service.resolveTemplate({ issueId });
    if ("data" in result) {
      expect(result.data.templateId).toBe(templateId);
    }
  });

  it("returns error when neither issueId nor projectId given", async () => {
    const { db } = createTestDb();
    const service = createService(db);

    const result = await service.resolveTemplate({});
    expect(result.error).toBe("issueId or projectId required");
  });
});

describe("workflow.service — progress", () => {
  it("returns workspace progress with transitions and next stages", async () => {
    const { db } = createTestDb();
    const service = createService(db);
    const { projectId, statusId } = await seedProject(db, "progress");
    const { templateId, nodeIds } = await seedLinearWorkflow(db, ["Start", "Build", "Done"]);
    const [, buildId, doneId] = nodeIds;

    const issueId = await seedIssue(db, projectId, statusId, 1, "Progress issue", {
      workflowTemplateId: templateId,
      currentNodeId: buildId,
    });
    const wsId = await seedWorkspace(db, issueId, "feature/progress", buildId);

    await db.insert(schema.workflowTransitions).values([
      { id: randomUUID(), workspaceId: wsId, fromNodeId: null, toNodeId: nodeIds[0], createdAt: "2026-05-30T10:00:00.000Z", triggeredBy: "system" },
      { id: randomUUID(), workspaceId: wsId, fromNodeId: nodeIds[0], toNodeId: buildId, createdAt: "2026-05-30T10:05:00.000Z", triggeredBy: "manual" },
    ]);

    const result = await service.getWorkspaceProgress(wsId);
    if ("data" in result) {
      expect(result.data.currentNodeId).toBe(buildId);
      expect(result.data.transitions).toHaveLength(2);
      expect(result.data.nextTransitions.length).toBeGreaterThan(0);
      expect(result.data.nextTransitions[0].toNodeId).toBe(doneId);
    }
  });

  it("returns error for unknown workspace", async () => {
    const { db } = createTestDb();
    const service = createService(db);

    const result = await service.getWorkspaceProgress(randomUUID());
    expect(result.error).toBe("Workspace not found");
  });
});

describe("workflow.service — transitions", () => {
  it("advances workspace node and syncs issue status", async () => {
    const { db } = createTestDb();
    const service = createService(db);
    const { projectId, statusId } = await seedProject(db, "transition-advance");
    const inReviewStatusId = randomUUID();
    const now = "2026-05-30T09:00:00.000Z";
    await db.insert(schema.projectStatuses).values({
      id: inReviewStatusId, projectId, name: "In Review", sortOrder: 1, isDefault: false, createdAt: now,
    });
    const { templateId, nodeIds } = await seedLinearWorkflow(db, ["Implement", "Review"], ["In Progress", "In Review"]);
    const [implId, reviewId] = nodeIds;

    const issueId = await seedIssue(db, projectId, statusId, 1, "Transition issue", {
      workflowTemplateId: templateId,
      currentNodeId: implId,
    });
    const wsId = await seedWorkspace(db, issueId, "feature/trans", implId);

    const result = await service.executeTransition(wsId, { toNodeName: "Review", summary: "ready" });
    if ("data" in result) {
      expect(result.data.ok).toBe(true);
      expect(result.data.movedTo).toBe("Review");
      expect(result.data.status).toBe("In Review");
    }

    const issue = (await db.select().from(schema.issues).where(eq(schema.issues.id, issueId)))[0];
    expect(issue.currentNodeId).toBe(reviewId);
    expect(issue.statusId).toBe(inReviewStatusId);
  });

  it("rejects transition to invalid stage", async () => {
    const { db } = createTestDb();
    const service = createService(db);
    const { projectId, statusId } = await seedProject(db, "transition-invalid");
    const { templateId, nodeIds } = await seedLinearWorkflow(db, ["Start", "End"]);
    const [startId] = nodeIds;

    const issueId = await seedIssue(db, projectId, statusId, 1, "Invalid trans", {
      workflowTemplateId: templateId,
      currentNodeId: startId,
    });
    const wsId = await seedWorkspace(db, issueId, "feature/inv", startId);

    const result = await service.executeTransition(wsId, { toNodeName: "Nonexistent" });
    expect(result.error).toContain("No valid transition");
  });

  it("rejects transition without target", async () => {
    const { db } = createTestDb();
    const service = createService(db);

    const result = await service.executeTransition(randomUUID(), {});
    expect(result.error).toBe("toNodeId or toNodeName is required");
  });

  it("rejects transition from workspace with no workflow", async () => {
    const { db } = createTestDb();
    const service = createService(db);
    const { projectId, statusId } = await seedProject(db, "no-workflow");

    const issueId = await seedIssue(db, projectId, statusId, 1, "No workflow");
    const wsId = await seedWorkspace(db, issueId, "feature/none", null);

    const result = await service.executeTransition(wsId, { toNodeName: "End" });
    expect(result.error).toContain("not running a workflow");
  });

  it("materializes phase artifacts during transition", async () => {
    const { db } = createTestDb();
    const service = createService(db);
    const worktreePath = mkdtempSync(join(tmpdir(), "ak-svc-phase-"));
    try {
      const { projectId, statusId } = await seedProject(db, "svc-phase-artifact");
      const now = "2026-05-30T09:00:00.000Z";
      const { templateId, nodeIds } = await seedLinearWorkflow(db, ["Specify", "Design"], ["In Progress", "In Progress"]);
      const [specifyId, designId] = nodeIds;

      const issueId = await seedIssue(db, projectId, statusId, 7, "Svc Phase Artifacts!", {
        workflowTemplateId: templateId,
        currentNodeId: specifyId,
      });
      const wsId = await seedWorkspace(db, issueId, "feature/svc-spec", specifyId, worktreePath);
      await db.insert(schema.issueArtifacts).values({
        id: randomUUID(), issueId, workspaceId: wsId, type: "text",
        mimeType: "text/markdown", caption: "phase-artifact:specify",
        content: "# spec\n\nApproved.\n", createdAt: now,
      });

      const result = await service.executeTransition(wsId, { toNodeId: designId });
      if ("data" in result) {
        expect(result.data.phaseArtifact.relativePath).toBeTruthy();
      }
    } finally {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });
});

describe("workflow.service — getTemplate / getStageWorkspaceVisits", () => {
  it("returns 404 for unknown template", async () => {
    const { db } = createTestDb();
    const service = createService(db);

    const result = await service.getTemplate(randomUUID());
    expect(result.error).toBe("Template not found");
  });

  it("returns 404 for unknown stage in workspace visits", async () => {
    const { db } = createTestDb();
    const service = createService(db);

    const result = await service.getStageWorkspaceVisits({
      templateId: randomUUID(),
      nodeId: randomUUID(),
    });
    expect(result.error).toBe("Workflow stage not found");
  });
});
