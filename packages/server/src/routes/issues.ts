import { Hono } from "hono";
import { db } from "../db/index.js";
import { issues, projectStatuses, workspaces, tags, issueTags, sessions, sessionMessages, diffComments, issueDependencies } from "@agentic-kanban/shared/schema";
import { eq, and, sql, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Database } from "../db/index.js";
import type { BoardEvents } from "../services/board-events.js";

export function createIssuesRoute(database: Database = db, options?: { boardEvents?: BoardEvents }) {
  const router = new Hono();

  // GET /api/issues?projectId=...
  router.get("/", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) {
      return c.json({ error: "projectId query parameter required" }, 400);
    }

    const result = await database
      .select({
        id: issues.id,
        issueNumber: issues.issueNumber,
        title: issues.title,
        description: issues.description,
        priority: issues.priority,
        sortOrder: issues.sortOrder,
        statusId: issues.statusId,
        projectId: issues.projectId,
        createdAt: issues.createdAt,
        updatedAt: issues.updatedAt,
        statusChangedAt: issues.statusChangedAt,
        skipAutoReview: issues.skipAutoReview,
        statusName: projectStatuses.name,
      })
      .from(issues)
      .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .where(eq(issues.projectId, projectId))
      .orderBy(issues.sortOrder);

    return c.json(result);
  });

  // POST /api/issues
  router.post("/", async (c) => {
    const body = await c.req.json();
    const now = new Date().toISOString();
    const id = randomUUID();

    // Auto-assign issue number per project
    const maxResult = await database
      .select({ maxNum: sql<number | null>`max(${issues.issueNumber})` })
      .from(issues)
      .where(eq(issues.projectId, body.projectId));
    const issueNumber = (maxResult[0]?.maxNum ?? 0) + 1;

    // Default statusId to the first status for the project if not provided
    let statusId = body.statusId;
    if (!statusId) {
      const statuses = await database
        .select({ id: projectStatuses.id })
        .from(projectStatuses)
        .where(eq(projectStatuses.projectId, body.projectId))
        .limit(1);
      if (statuses.length === 0) {
        return c.json({ error: "No statuses found for project" }, 400);
      }
      statusId = statuses[0].id;
    }

    await database.insert(issues).values({
      id,
      issueNumber,
      title: body.title,
      description: body.description ?? null,
      priority: body.priority ?? "medium",
      skipAutoReview: body.skipAutoReview ?? false,
      sortOrder: body.sortOrder ?? 0,
      statusId,
      projectId: body.projectId,
      createdAt: now,
      updatedAt: now,
    });

    // Broadcast board event
    if (body.projectId) options?.boardEvents?.broadcast(body.projectId, "issue_created");

    return c.json({ id, issueNumber, title: body.title }, 201);
  });

  // PATCH /api/issues/:id
  router.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    const now = new Date().toISOString();

    const updates: Record<string, unknown> = { updatedAt: now };
    if (body.title !== undefined) updates.title = body.title;
    if (body.description !== undefined) updates.description = body.description;
    if (body.priority !== undefined) updates.priority = body.priority;
    if (body.statusId !== undefined) { updates.statusId = body.statusId; updates.statusChangedAt = now; }
    if (body.sortOrder !== undefined) updates.sortOrder = body.sortOrder;

    await database.update(issues).set(updates).where(eq(issues.id, id));

    // Resolve projectId for broadcast
    const rows = await database.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, id)).limit(1);
    if (rows.length > 0) {
      options?.boardEvents?.broadcast(rows[0].projectId, "issue_updated");
    }

    return c.json({ id });
  });

  // DELETE /api/issues/:id — cascade delete workspaces, sessions, messages, tags
  router.delete("/:id", async (c) => {
    const id = c.req.param("id");

    // Resolve projectId before delete
    const rows = await database.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, id)).limit(1);

    // Find all workspaces for this issue
    const wsRows = await database.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.issueId, id));

    // Cascade delete each workspace's diff comments, session messages, sessions
    for (const ws of wsRows) {
      const wsSessions = await database.select({ id: sessions.id }).from(sessions).where(eq(sessions.workspaceId, ws.id));
      await database.delete(diffComments).where(eq(diffComments.workspaceId, ws.id));
      if (wsSessions.length > 0) {
        await database.delete(sessionMessages).where(inArray(sessionMessages.sessionId, wsSessions.map(s => s.id)));
      }
      await database.delete(sessions).where(eq(sessions.workspaceId, ws.id));
      await database.delete(workspaces).where(eq(workspaces.id, ws.id));
    }

    // Delete issue tags and the issue itself
    await database.delete(issueTags).where(eq(issueTags.issueId, id));
    await database.delete(issues).where(eq(issues.id, id));

    if (rows.length > 0) {
      options?.boardEvents?.broadcast(rows[0].projectId, "issue_deleted");
    }

    return c.json({ success: true });
  });

  // GET /api/issues/:id/workspaces
  router.get("/:id/workspaces", async (c) => {
    const issueId = c.req.param("id");
    const result = await database
      .select()
      .from(workspaces)
      .where(eq(workspaces.issueId, issueId));
    return c.json(result);
  });

  // GET /api/issues/:id/tags
  router.get("/:id/tags", async (c) => {
    const issueId = c.req.param("id");
    const result = await database
      .select({ id: tags.id, name: tags.name, color: tags.color })
      .from(issueTags)
      .innerJoin(tags, eq(issueTags.tagId, tags.id))
      .where(eq(issueTags.issueId, issueId));
    return c.json(result);
  });

  // POST /api/issues/:id/tags — assign tag to issue
  router.post("/:id/tags", async (c) => {
    const issueId = c.req.param("id");
    const body = await c.req.json();
    if (!body.tagId) {
      return c.json({ error: "tagId is required" }, 400);
    }
    const id = randomUUID();
    await database.insert(issueTags).values({ id, issueId, tagId: body.tagId });
    return c.json({ id }, 201);
  });

  // DELETE /api/issues/:id/tags/:tagId — remove tag from issue
  router.delete("/:id/tags/:tagId", async (c) => {
    const issueId = c.req.param("id");
    const tagId = c.req.param("tagId");
    await database.delete(issueTags)
      .where(and(eq(issueTags.issueId, issueId), eq(issueTags.tagId, tagId)));
    return c.json({ success: true });
  });

  // GET /api/issues/:id/dependencies
  router.get("/:id/dependencies", async (c) => {
    const issueId = c.req.param("id");

    // Outgoing dependencies: this issue -> other issues
    const outgoing = await database
      .select({
        id: issueDependencies.id,
        issueId: issueDependencies.issueId,
        dependsOnId: issueDependencies.dependsOnId,
        type: issueDependencies.type,
        createdAt: issueDependencies.createdAt,
        issueTitle: issues.title,
        issueStatusName: projectStatuses.name,
        issueNumber: issues.issueNumber,
      })
      .from(issueDependencies)
      .innerJoin(issues, eq(issueDependencies.dependsOnId, issues.id))
      .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .where(eq(issueDependencies.issueId, issueId));

    // Incoming dependencies: other issues -> this issue
    const incoming = await database
      .select({
        id: issueDependencies.id,
        issueId: issueDependencies.issueId,
        dependsOnId: issueDependencies.dependsOnId,
        type: issueDependencies.type,
        createdAt: issueDependencies.createdAt,
        issueTitle: issues.title,
        issueStatusName: projectStatuses.name,
        issueNumber: issues.issueNumber,
      })
      .from(issueDependencies)
      .innerJoin(issues, eq(issueDependencies.issueId, issues.id))
      .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .where(eq(issueDependencies.dependsOnId, issueId));

    return c.json({ dependencies: [...outgoing, ...incoming] });
  });

  // POST /api/issues/:id/dependencies — add dependency with cycle detection
  router.post("/:id/dependencies", async (c) => {
    const issueId = c.req.param("id");
    const body = await c.req.json();
    const { dependsOnId, type } = body;

    if (!dependsOnId) {
      return c.json({ error: "dependsOnId is required" }, 400);
    }
    if (dependsOnId === issueId) {
      return c.json({ error: "An issue cannot depend on itself" }, 400);
    }

    const depType = type || "depends_on";
    const validTypes = ["depends_on", "blocked_by", "related_to", "duplicates", "parent_of", "child_of"];
    if (!validTypes.includes(depType)) {
      return c.json({ error: `Invalid dependency type. Must be one of: ${validTypes.join(", ")}` }, 400);
    }

    // Verify both issues exist and are in the same project
    const [sourceIssue, targetIssue] = await Promise.all([
      database.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, issueId)).limit(1),
      database.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, dependsOnId)).limit(1),
    ]);

    if (sourceIssue.length === 0) return c.json({ error: "Issue not found" }, 404);
    if (targetIssue.length === 0) return c.json({ error: "Dependency target issue not found" }, 404);
    if (sourceIssue[0].projectId !== targetIssue[0].projectId) {
      return c.json({ error: "Cannot add dependencies across projects" }, 400);
    }

    // Cycle detection: only for directional types (depends_on, blocked_by, parent_of, child_of)
    if (depType === "depends_on" || depType === "blocked_by" || depType === "parent_of" || depType === "child_of") {
      const wouldCycle = await wouldCreateCycle(database, issueId, dependsOnId, sourceIssue[0].projectId);
      if (wouldCycle) {
        return c.json({ error: "Adding this dependency would create a cycle" }, 409);
      }
    }

    const id = randomUUID();
    try {
      await database.insert(issueDependencies).values({
        id,
        issueId,
        dependsOnId,
        type: depType,
        createdAt: new Date().toISOString(),
      });
    } catch (err: any) {
      if (err.message?.includes("UNIQUE constraint")) {
        return c.json({ error: "This dependency already exists" }, 409);
      }
      throw err;
    }

    options?.boardEvents?.broadcast(sourceIssue[0].projectId, "dependency_added");

    return c.json({ id, type: depType }, 201);
  });

  // DELETE /api/issues/:id/dependencies/:depId — remove dependency by row ID
  router.delete("/:id/dependencies/:depId", async (c) => {
    const issueId = c.req.param("id");
    const depId = c.req.param("depId");

    await database.delete(issueDependencies)
      .where(and(eq(issueDependencies.id, depId), eq(issueDependencies.issueId, issueId)));

    // Resolve projectId for broadcast
    const rows = await database.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, issueId)).limit(1);
    if (rows.length > 0) {
      options?.boardEvents?.broadcast(rows[0].projectId, "dependency_removed");
    }

    return c.json({ success: true });
  });

  return router;
}

export const issuesRoute = createIssuesRoute();

async function wouldCreateCycle(database: Database, issueId: string, dependsOnId: string, projectId: string): Promise<boolean> {
  // Load all dependencies for the project
  const allDeps = await database
    .select({
      depIssueId: issueDependencies.issueId,
      depDependsOnId: issueDependencies.dependsOnId,
    })
    .from(issueDependencies)
    .innerJoin(issues, eq(issueDependencies.issueId, issues.id))
    .where(eq(issues.projectId, projectId));

  // Build adjacency: issueId -> Set of dependsOnIds
  const adj = new Map<string, Set<string>>();
  for (const dep of allDeps) {
    let set = adj.get(dep.depIssueId);
    if (!set) { set = new Set(); adj.set(dep.depIssueId, set); }
    set.add(dep.depDependsOnId);
  }

  // DFS from dependsOnId: if we can reach issueId, adding this edge creates a cycle
  const visited = new Set<string>();
  const stack = [dependsOnId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === issueId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const neighbors = adj.get(current);
    if (neighbors) {
      for (const n of neighbors) stack.push(n);
    }
  }
  return false;
}
