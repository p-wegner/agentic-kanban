import { Hono } from "hono";
import { and, eq, gte } from "drizzle-orm";
import { issues, projectStatuses } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import type { BoardEvents } from "../services/board-events.js";
import type { SessionManager } from "../services/session.manager.js";
import type { ShowdownContestant } from "@agentic-kanban/shared";
import { analyzeDependencies, enhanceIssue, aiEstimateIssue, decomposeEpic, confirmEpicDecomposition, analyzeTouchedFiles } from "../services/issue-ai.service.js";
import { createIssueService } from "../services/issue.service.js";
import { getIssueDescription } from "../repositories/issue.repository.js";
import { createIssueCommentsService } from "../services/issue-comments.service.js";
import { createIssueTimeEntriesService } from "../services/issue-time-entries.service.js";
import type { IssueCommentKind, IssueCommentAuthor } from "../repositories/issue-comments.repository.js";
import { createShowdownService } from "../services/showdown.service.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { createRouter } from "../middleware/create-router.js";
import { wrapAiOperation } from "../middleware/ai-operation.js";
import { runTicketPreflight, formatClarificationsBlock, type PreflightClarification } from "../services/ticket-preflight.service.js";
import { WorkspaceError } from "../services/workspace-internals.js";
import { getIssueActivity } from "../services/issue-activity.service.js";
import { getIssueCycleTime } from "../services/cycle-time.service.js";
import { createWebhookSender } from "../services/outbound-webhook.service.js";

export function createIssuesRoute(database: Database = db, options?: { boardEvents?: BoardEvents; getSessionManager?: () => SessionManager }) {
  const router = createRouter();

  const issueService = createIssueService({ database, boardEvents: options?.boardEvents, sendWebhook: createWebhookSender(database) });
  const issueCommentsService = createIssueCommentsService({ database, boardEvents: options?.boardEvents });
  const timeEntriesService = createIssueTimeEntriesService({ database });
  const showdownService = createShowdownService({
    database,
    getSessionManager: options?.getSessionManager,
    boardEvents: options?.boardEvents,
  });

  // GET /api/issues?projectId=...&issueNumber=N&statusName=InProgress
  router.get("/", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "projectId query parameter required" }, 400);
    const issueNumberParam = c.req.query("issueNumber");
    const statusName = c.req.query("statusName") || undefined;
    const result = await issueService.listIssues(
      projectId,
      issueNumberParam ? Number(issueNumberParam) : undefined,
      statusName,
    );
    return c.json(result);
  });

  // POST /api/issues/enhance — AI-enhance a ticket title and description
  router.post("/enhance", async (c) => {
    const body = await parseJsonBody<{ title: string; description?: string; projectId?: string }>(c);
    if (!body.title?.trim()) return c.json({ error: "title is required" }, 400);
    return c.json(await wrapAiOperation("enhance", () => enhanceIssue(body.title, body.description, database)));
  });

  // POST /api/issues/analyze-dependencies — AI-analyze dependencies for an issue
  router.post("/analyze-dependencies", async (c) => {
    const body = await parseJsonBody<{ issueId: string; projectId: string }>(c);
    if (!body.issueId || !body.projectId) return c.json({ error: "issueId and projectId are required" }, 400);
    const result = await wrapAiOperation("analyze-deps", () => analyzeDependencies(body.issueId, body.projectId, database));
    if (result.total > 0) options?.boardEvents?.broadcast(body.projectId, "dependency_added");
    return c.json(result);
  });

  // POST /api/issues/ai-estimate — AI-suggest a T-shirt size estimate for an issue
  router.post("/ai-estimate", async (c) => {
    const body = await parseJsonBody<{ issueId: string }>(c);
    if (!body.issueId) return c.json({ error: "issueId is required" }, 400);
    return c.json(await wrapAiOperation("ai-estimate", () => aiEstimateIssue(body.issueId, database)));
  });

  // POST /api/issues/:id/decompose — AI-generate epic decomposition proposal
  router.post("/:id/decompose", async (c) => {
    const issueId = c.req.param("id");
    const body = await parseJsonBody<{ projectId: string }>(c);
    if (!body.projectId) return c.json({ error: "projectId is required" }, 400);
    return c.json(await wrapAiOperation("decompose", () => decomposeEpic(issueId, body.projectId, database)));
  });

  // POST /api/issues/:id/decompose/confirm — confirm epic decomposition and create child issues
  router.post("/:id/decompose/confirm", async (c) => {
    const issueId = c.req.param("id");
    const body = await parseJsonBody<{ projectId: string; children: any[]; dependencies: any[] }>(c);
    if (!body.projectId) return c.json({ error: "projectId is required" }, 400);
    if (!Array.isArray(body.children)) return c.json({ error: "children must be an array" }, 400);
    if (!Array.isArray(body.dependencies)) return c.json({ error: "dependencies must be an array" }, 400);
    const result = await confirmEpicDecomposition(
      { issueId, projectId: body.projectId, children: body.children, dependencies: body.dependencies },
      database,
    );
    options?.boardEvents?.broadcast(body.projectId, "issue_created");
    return c.json(result, 201);
  });

  // POST /api/issues/batch — create N issues atomically
  router.post("/batch", async (c) => {
    const body = await parseJsonBody<{ projectId: string; issues: any[] }>(c);
    if (!body.projectId) return c.json({ error: "projectId is required" }, 400);
    if (!Array.isArray(body.issues)) return c.json({ error: "issues must be an array" }, 400);
    try {
      const result = await issueService.createIssuesBatch(body.projectId, body.issues);
      return c.json({ issues: result }, 201);
    } catch (err: any) {
      if (err.code === "BAD_REQUEST") {
        const payload: any = { error: err.message };
        if (typeof err.index === "number") payload.index = err.index;
        return c.json(payload, 400);
      }
      throw err;
    }
  });

  // POST /api/issues/dependencies/batch — add/remove N dependency edges atomically
  router.post("/dependencies/batch", async (c) => {
    const body = await parseJsonBody<{ edges: any[] }>(c);
    if (!Array.isArray(body.edges)) return c.json({ error: "edges must be an array" }, 400);
    try {
      const result = await issueService.updateDependenciesBatch(body.edges);
      return c.json({ added: result.added, removed: result.removed, skipped: result.skipped });
    } catch (err: any) {
      if (err.code === "BAD_REQUEST") {
        const payload: any = { error: err.message };
        if (typeof err.index === "number") payload.index = err.index;
        return c.json(payload, 400);
      }
      if (err.code === "CONFLICT") {
        const payload: any = { error: err.message };
        if (typeof err.index === "number") payload.index = err.index;
        return c.json(payload, 400);
      }
      throw err;
    }
  });

  // POST /api/issues/archive-done — move Done issues older than N days to Archived
  router.post("/archive-done", async (c) => {
    const body = await parseJsonBody<{ projectId?: string; olderThanDays?: number; nowOverride?: string }>(c);
    if (!body.projectId) return c.json({ error: "projectId is required" }, 400);
    const days = Number(body.olderThanDays);
    if (!Number.isFinite(days) || days <= 0) {
      return c.json({ error: "olderThanDays must be a positive number" }, 400);
    }
    try {
      const result = await issueService.archiveDoneIssues(body.projectId, days, body.nowOverride);
      return c.json({ archived: result.archived });
    } catch (err: any) {
      if (err.code === "BAD_REQUEST") return c.json({ error: err.message }, 400);
      if (err.code === "NOT_FOUND") return c.json({ error: err.message }, 404);
      throw err;
    }
  });

  // PATCH /api/issues/bulk - update N issues in one request
  router.patch("/bulk", async (c) => {
    const body = await parseJsonBody<{ issueIds?: string[]; updates?: Record<string, unknown> }>(c);
    if (!Array.isArray(body.issueIds) || body.issueIds.length === 0) {
      return c.json({ error: "issueIds must be a non-empty array" }, 400);
    }
    if (!body.updates || typeof body.updates !== "object") {
      return c.json({ error: "updates is required" }, 400);
    }
    try {
      const result = await issueService.updateIssuesBulk(body.issueIds, body.updates);
      return c.json({ updated: result.updated });
    } catch (err: any) {
      if (err.code === "BAD_REQUEST") return c.json({ error: err.message }, 400);
      if (err.code === "NOT_FOUND") return c.json({ error: err.message }, 404);
      throw err;
    }
  });

  // POST /api/issues
  router.post("/", async (c) => {
    const body = await parseJsonBody(c);
    if (!body.projectId) return c.json({ error: "projectId is required" }, 400);
    if (!body.title?.trim()) return c.json({ error: "title is required" }, 400);

    try {
      const result = await issueService.createIssue({
        projectId: body.projectId,
        title: body.title,
        description: body.description,
        priority: body.priority,
        issueType: body.issueType,
        skipAutoReview: body.skipAutoReview,
        estimate: body.estimate,
        sortOrder: body.sortOrder,
        statusId: body.statusId,
        workflowTemplateId: body.workflowTemplateId,
        externalKey: body.externalKey,
        externalUrl: body.externalUrl,
      });
      return c.json(result, 201);
    } catch (err: any) {
      if (err.code === "BAD_REQUEST") return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  // GET /api/issues/:id/touched-files — return cached prediction only (no AI call)
  router.get("/:id/touched-files", async (c) => {
    const issueId = c.req.param("id");
    const rows = await database.select({ touchedFilesJson: issues.touchedFilesJson }).from(issues).where(eq(issues.id, issueId)).limit(1);
    if (rows.length === 0) return c.json({ error: "Issue not found" }, 404);
    const json = rows[0].touchedFilesJson;
    let files: unknown[] = [];
    if (json) {
      try { files = JSON.parse(json); } catch { files = []; }
    }
    return c.json({ files, cached: true });
  });

  // POST /api/issues/:id/analyze-touched-files — run (or re-run) AI prediction
  router.post("/:id/analyze-touched-files", async (c) => {
    const issueId = c.req.param("id");
    const body = await parseJsonBody<{ refresh?: boolean }>(c).catch(() => ({ refresh: false }));
    return c.json(await wrapAiOperation("analyze-touched-files", () => analyzeTouchedFiles(issueId, database, body?.refresh === true)));
  });

  // GET /api/issues/:id/related-issues — find other issues that share touched files with this one
  router.get("/:id/related-issues", async (c) => {
    const issueId = c.req.param("id");
    const rows = await database.select({ touchedFilesJson: issues.touchedFilesJson, projectId: issues.projectId }).from(issues).where(eq(issues.id, issueId)).limit(1);
    if (rows.length === 0) return c.json({ error: "Issue not found" }, 404);
    const json = rows[0].touchedFilesJson;
    if (!json) return c.json({ related: [] });
    let myFiles: { path: string }[] = [];
    try { myFiles = JSON.parse(json); } catch { return c.json({ related: [] }); }
    const myPaths = new Set(myFiles.map((f) => f.path));
    if (myPaths.size === 0) return c.json({ related: [] });

    const candidates = await database.select({
      id: issues.id,
      issueNumber: issues.issueNumber,
      title: issues.title,
      touchedFilesJson: issues.touchedFilesJson,
    }).from(issues).where(and(eq(issues.projectId, rows[0].projectId)));

    const related: { id: string; issueNumber: number | null; title: string; sharedFileCount: number }[] = [];
    for (const candidate of candidates) {
      if (candidate.id === issueId) continue;
      if (!candidate.touchedFilesJson) continue;
      let candidateFiles: { path: string }[] = [];
      try { candidateFiles = JSON.parse(candidate.touchedFilesJson); } catch { continue; }
      const sharedCount = candidateFiles.filter((f) => myPaths.has(f.path)).length;
      if (sharedCount > 0) {
        related.push({ id: candidate.id, issueNumber: candidate.issueNumber, title: candidate.title, sharedFileCount: sharedCount });
      }
    }
    related.sort((a, b) => b.sharedFileCount - a.sharedFileCount);
    return c.json({ related });
  });


  // POST /api/issues/:id/preflight — AI ticket sanity check.
  // Optional `clarifications` (answered preflight questions): when present, they are
  // persisted as a durable `preflight-clarification` comment and folded into the prompt
  // for the re-check. The returned `clarificationsBlock` is the markdown the caller can
  // prepend to the launching agent's context.
  router.post("/:id/preflight", async (c) => {
    const issueId = c.req.param("id");
    const body = await parseJsonBody<{ projectId: string; clarifications?: PreflightClarification[] }>(c);
    if (!body.projectId) return c.json({ error: "projectId is required" }, 400);

    const answered = (body.clarifications ?? []).filter(
      (cl) => cl && typeof cl.question === "string" && typeof cl.answer === "string" && cl.question.trim() && cl.answer.trim(),
    );

    let clarificationsBlock: string | undefined;
    if (answered.length > 0) {
      clarificationsBlock = formatClarificationsBlock(answered);
      // Persist the answered Q&A as durable ticket history before re-checking.
      await issueCommentsService.addComment({
        issueId,
        kind: "preflight-clarification",
        author: "user",
        body: clarificationsBlock,
        payload: { clarifications: answered },
      });
    }

    const result = await wrapAiOperation("preflight", () =>
      runTicketPreflight(issueId, body.projectId, database, answered.length > 0 ? answered : undefined),
    );

    // Persist the verdict as a durable audit comment (only for the initial check, not re-checks with clarifications)
    if (answered.length === 0) {
      const verdictBody = result.summary
        ? `Preflight verdict: **${result.verdict}** — ${result.summary}`
        : `Preflight verdict: **${result.verdict}**`;
      await issueCommentsService.addComment({
        issueId,
        kind: "preflight-verdict",
        author: "preflight",
        body: verdictBody,
        payload: { verdict: result.verdict, looksComplex: result.looksComplex, questionsCount: result.questions.length },
      });
    }

    return c.json({ ...result, clarificationsBlock });
  });

  // GET /api/issues/:id/cycle-time — per-status time aggregation derived from workflow transitions
  router.get("/:id/cycle-time", async (c) => {
    const issueId = c.req.param("id");
    const result = await getIssueCycleTime(issueId, database);
    if (!result) return c.json({ error: "Issue not found" }, 404);
    return c.json(result);
  });

  // GET /api/issues/:id/activity — chronological audit feed aggregated from workspaces/sessions/comments
  router.get("/:id/activity", async (c) => {
    const issueId = c.req.param("id");
    const result = await getIssueActivity(issueId, database);
    if (!result) return c.json({ error: "Issue not found" }, 404);
    return c.json(result);
  });

  // GET /api/issues/:id — returns the issue with its full description (used for lazy-loading)
  router.get("/:id", async (c) => {
    const id = c.req.param("id");
    const result = await getIssueDescription(id, database);
    if (!result) return c.json({ error: "Issue not found" }, 404);
    return c.json(result);
  });

  // GET /api/issues/:id/summary
  router.get("/:id/summary", async (c) => {
    const idParam = c.req.param("id");
    const result = await issueService.getIssueSummary(idParam);
    if (!result) return c.json({ error: "Issue not found" }, 404);
    return c.json(result);
  });

  // PATCH /api/issues/:id
  router.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const body = await parseJsonBody(c);
    try {
      const result = await issueService.updateIssue(id, body);
      return c.json({ id: result.id });
    } catch (err: any) {
      if (err.code === "BAD_REQUEST") return c.json({ error: err.message }, 400);
      if (err.code === "NOT_FOUND") return c.json({ error: err.message }, 404);
      throw err;
    }
  });

  // POST /api/issues/:id/duplicate
  router.post("/:id/duplicate", async (c) => {
    const id = c.req.param("id");
    try {
      const result = await issueService.duplicateIssue(id);
      return c.json(result, 201);
    } catch (err: any) {
      if (err.code === "NOT_FOUND") return c.json({ error: err.message }, 404);
      throw err;
    }
  });

  // DELETE /api/issues/:id
  router.delete("/:id", async (c) => {
    const id = c.req.param("id");
    await issueService.deleteIssue(id);
    return c.json({ success: true });
  });

  // GET /api/issues/:id/workspaces
  router.get("/:id/workspaces", async (c) => {
    const issueId = c.req.param("id");
    return c.json(await issueService.getEnrichedWorkspaces(issueId));
  });

  // GET /api/issues/:id/tags
  router.get("/:id/tags", async (c) => {
    const issueId = c.req.param("id");
    return c.json(await issueService.getTags(issueId));
  });

  // POST /api/issues/:id/tags
  router.post("/:id/tags", async (c) => {
    const issueId = c.req.param("id");
    const body = await parseJsonBody(c);
    if (!body.tagId) return c.json({ error: "tagId is required" }, 400);
    const result = await issueService.assignTag(issueId, body.tagId);
    return c.json(result, 201);
  });

  // DELETE /api/issues/:id/tags/:tagId
  router.delete("/:id/tags/:tagId", async (c) => {
    const issueId = c.req.param("id");
    const tagId = c.req.param("tagId");
    await issueService.removeTag(issueId, tagId);
    return c.json({ success: true });
  });

  // GET /api/issues/:id/dependencies
  router.get("/:id/dependencies", async (c) => {
    const issueId = c.req.param("id");
    return c.json(await issueService.getDependencies(issueId));
  });

  // POST /api/issues/:id/dependencies
  router.post("/:id/dependencies", async (c) => {
    const issueId = c.req.param("id");
    const body = await parseJsonBody(c);
    if (!body.dependsOnId) return c.json({ error: "dependsOnId is required" }, 400);

    const result = await issueService.addDependency(issueId, body.dependsOnId, body.type);
    return c.json({ id: result.id, type: result.type }, 201);
  });

  // DELETE /api/issues/:id/dependencies/:depId
  router.delete("/:id/dependencies/:depId", async (c) => {
    const issueId = c.req.param("id");
    const depId = c.req.param("depId");
    await issueService.removeDependency(issueId, depId);
    return c.json({ success: true });
  });

  // GET /api/issues/:id/artifacts
  router.get("/:id/artifacts", async (c) => {
    const issueId = c.req.param("id");
    return c.json(await issueService.getArtifacts(issueId));
  });

  // POST /api/issues/:id/artifacts
  router.post("/:id/artifacts", async (c) => {
    const issueId = c.req.param("id");
    const body = await parseJsonBody<{ type: string; mimeType?: string; content: string; caption?: string; workspaceId?: string }>(c);
    if (!body.type || !body.content) return c.json({ error: "type and content are required" }, 400);

    const result = await issueService.addArtifact(issueId, body);
    return c.json({ id: result.id }, 201);
  });

  // DELETE /api/issues/:id/artifacts/:artifactId
  router.delete("/:id/artifacts/:artifactId", async (c) => {
    const issueId = c.req.param("id");
    const artifactId = c.req.param("artifactId");
    await issueService.deleteArtifact(issueId, artifactId);
    return c.json({ success: true });
  });

  // GET /api/issues/:id/comments — durable Q&A / activity thread for an issue
  router.get("/:id/comments", async (c) => {
    const issueId = c.req.param("id");
    return c.json({ comments: await issueCommentsService.listComments(issueId) });
  });

  // POST /api/issues/:id/comments
  router.post("/:id/comments", async (c) => {
    const issueId = c.req.param("id");
    const body = await parseJsonBody<{
      kind?: IssueCommentKind;
      author?: IssueCommentAuthor;
      body?: string;
      payload?: unknown;
      workspaceId?: string;
    }>(c);
    const validKinds: IssueCommentKind[] = ["preflight-clarification", "agent-question", "merge-attempt", "note"];
    const validAuthors: IssueCommentAuthor[] = ["user", "butler", "agent", "preflight", "system"];
    if (!body.body?.trim()) return c.json({ error: "body is required" }, 400);
    const kind = body.kind && validKinds.includes(body.kind) ? body.kind : "note";
    const author = body.author && validAuthors.includes(body.author) ? body.author : "user";
    const comment = await issueCommentsService.addComment({
      issueId,
      workspaceId: body.workspaceId ?? null,
      kind,
      author,
      body: body.body,
      payload: body.payload,
    });
    return c.json(comment, 201);
  });

  // DELETE /api/issues/:id/comments/:commentId
  router.delete("/:id/comments/:commentId", async (c) => {
    const issueId = c.req.param("id");
    const commentId = c.req.param("commentId");
    await issueCommentsService.removeComment(issueId, commentId);
    return c.json({ success: true });
  });

  // GET /api/issues/:id/time-entries
  router.get("/:id/time-entries", async (c) => {
    const issueId = c.req.param("id");
    const entries = await timeEntriesService.listEntries(issueId);
    const total = await timeEntriesService.totalMinutes(issueId);
    return c.json({ entries, totalMinutes: total });
  });

  // POST /api/issues/:id/time-entries
  router.post("/:id/time-entries", async (c) => {
    const issueId = c.req.param("id");
    const body = await parseJsonBody<{ minutes?: number; note?: string }>(c);
    const minutes = Number(body.minutes);
    if (!Number.isInteger(minutes) || minutes <= 0) {
      return c.json({ error: "minutes must be a positive integer" }, 400);
    }
    const entry = await timeEntriesService.addEntry({ issueId, minutes, note: body.note ?? null });
    return c.json(entry, 201);
  });

  // DELETE /api/issues/:id/time-entries/:entryId
  router.delete("/:id/time-entries/:entryId", async (c) => {
    const entryId = c.req.param("entryId");
    await timeEntriesService.removeEntry(entryId);
    return c.json({ success: true });
  });

  // POST /api/issues/:id/showdown — start a showdown with N contestants
  router.post("/:id/showdown", async (c) => {
    const issueId = c.req.param("id");
    const body = await parseJsonBody<{ contestants: ShowdownContestant[] }>(c);
    if (!Array.isArray(body.contestants) || body.contestants.length < 2) {
      return c.json({ error: "contestants must be an array with at least 2 entries" }, 400);
    }
    try {
      const result = await showdownService.createShowdown(issueId, body.contestants);
      return c.json(result, 201);
    } catch (err) {
      if (err instanceof WorkspaceError) {
        return c.json({ error: err.message }, err.code === "NOT_FOUND" ? 404 : 400);
      }
      throw err;
    }
  });

  // GET /api/issues/cfd?projectId=&days= — cumulative flow diagram data.
  // Returns one entry per (date, status) pair: the count of issues that were
  // in that status as of the end of that day (based on statusChangedAt or
  // createdAt when no explicit status change is recorded).
  router.get("/cfd", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "projectId required" }, 400);
    const daysRaw = parseInt(c.req.query("days") ?? "30", 10);
    const days = Math.min(Math.max(Number.isNaN(daysRaw) ? 30 : daysRaw, 1), 365);

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    // Single query: all issues for the project with status metadata.
    const rows = await database
      .select({
        issueId: issues.id,
        createdAt: issues.createdAt,
        statusChangedAt: issues.statusChangedAt,
        statusName: projectStatuses.name,
        statusSortOrder: projectStatuses.sortOrder,
      })
      .from(issues)
      .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .where(eq(issues.projectId, projectId));

    // Collect all statuses (sorted by board order).
    const statusMeta = new Map<string, { sortOrder: number }>();
    for (const r of rows) {
      if (!statusMeta.has(r.statusName)) {
        statusMeta.set(r.statusName, { sortOrder: r.statusSortOrder });
      }
    }
    const statuses = [...statusMeta.entries()]
      .sort((a, b) => a[1].sortOrder - b[1].sortOrder)
      .map(([name]) => name);

    // Build the date axis: one entry per day in [cutoffDate, today].
    const today = new Date();
    const dates: string[] = [];
    for (let d = new Date(cutoffDate); d <= today; d.setDate(d.getDate() + 1)) {
      dates.push(d.toISOString().slice(0, 10));
    }

    // For each day, count issues per status.
    // An issue is counted in status X on day D if:
    //   - its current status is X, AND
    //   - it entered that status on or before D (statusChangedAt <= D, or
    //     statusChangedAt is null and createdAt <= D).
    const counts: { date: string; status: string; count: number }[] = [];
    for (const date of dates) {
      const byStatus = new Map<string, number>();
      for (const s of statuses) byStatus.set(s, 0);
      for (const r of rows) {
        const enteredAt = r.statusChangedAt ?? r.createdAt;
        const enteredDay = enteredAt.slice(0, 10);
        if (enteredDay <= date) {
          byStatus.set(r.statusName, (byStatus.get(r.statusName) ?? 0) + 1);
        }
      }
      for (const [status, count] of byStatus) {
        counts.push({ date, status, count });
      }
    }

    return c.json({ statuses, counts });
  });

  // GET /api/issues/throughput?projectId=&days= — daily throughput: count of issues moved to Done per calendar day.
  // Uses statusChangedAt to identify when issues entered the Done status.
  // Returns one data point per day for the trailing `days` window (default 14).
  router.get("/throughput", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "projectId required" }, 400);
    const daysRaw = parseInt(c.req.query("days") ?? "14", 10);
    const days = Math.min(Math.max(Number.isNaN(daysRaw) ? 14 : daysRaw, 1), 365);

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days + 1);
    const cutoffDay = cutoffDate.toISOString().slice(0, 10);

    // Fetch only "Done" issues whose statusChangedAt falls within the window.
    const rows = await database
      .select({
        statusChangedAt: issues.statusChangedAt,
      })
      .from(issues)
      .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .where(
        and(
          eq(issues.projectId, projectId),
          eq(projectStatuses.name, "Done"),
          gte(issues.statusChangedAt, cutoffDay)
        )
      );

    // Build the date axis: one entry per day in the trailing window.
    const today = new Date();
    const dates: string[] = [];
    for (let d = new Date(cutoffDate); d <= today; d.setDate(d.getDate() + 1)) {
      dates.push(d.toISOString().slice(0, 10));
    }

    // Count issues per day that moved into "Done" on that exact day.
    const countByDate = new Map<string, number>(dates.map((d) => [d, 0]));
    for (const r of rows) {
      if (!r.statusChangedAt) continue;
      const movedDay = r.statusChangedAt.slice(0, 10);
      if (countByDate.has(movedDay)) {
        countByDate.set(movedDay, (countByDate.get(movedDay) ?? 0) + 1);
      }
    }

    const points = dates.map((date) => ({ date, count: countByDate.get(date) ?? 0 }));
    return c.json({ points });
  });

  // GET /api/issues/lead-time?projectId=&days= — lead time trend: median + p90 per day for issues that reached Done.
  // Lead time = Done statusChangedAt - createdAt (wall-clock age of the issue).
  // Returns one bucket per day in the trailing window; buckets with no completions have medianMs/p90Ms = null.
  router.get("/lead-time", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "projectId required" }, 400);
    const daysRaw = parseInt(c.req.query("days") ?? "30", 10);
    const days = Math.min(Math.max(Number.isNaN(daysRaw) ? 30 : daysRaw, 1), 365);

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days + 1);
    const cutoffDay = cutoffDate.toISOString().slice(0, 10);

    const rows = await database
      .select({
        createdAt: issues.createdAt,
        statusChangedAt: issues.statusChangedAt,
      })
      .from(issues)
      .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .where(
        and(
          eq(issues.projectId, projectId),
          eq(projectStatuses.name, "Done"),
          gte(issues.statusChangedAt, cutoffDay)
        )
      );

    // Build date axis.
    const today = new Date();
    const dates: string[] = [];
    for (let d = new Date(cutoffDate); d <= today; d.setDate(d.getDate() + 1)) {
      dates.push(d.toISOString().slice(0, 10));
    }

    // Group lead times (ms) per day.
    const byDate = new Map<string, number[]>(dates.map((d) => [d, []]));
    for (const r of rows) {
      if (!r.statusChangedAt || !r.createdAt) continue;
      const day = r.statusChangedAt.slice(0, 10);
      if (!byDate.has(day)) continue;
      const leadMs = new Date(r.statusChangedAt).getTime() - new Date(r.createdAt).getTime();
      if (leadMs >= 0) byDate.get(day)!.push(leadMs);
    }

    function percentile(sorted: number[], p: number): number {
      if (sorted.length === 0) return 0;
      const idx = (p / 100) * (sorted.length - 1);
      const lo = Math.floor(idx);
      const hi = Math.ceil(idx);
      return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
    }

    const buckets = dates.map((date) => {
      const vals = [...(byDate.get(date) ?? [])].sort((a, b) => a - b);
      return {
        date,
        count: vals.length,
        medianMs: vals.length > 0 ? percentile(vals, 50) : null,
        p90Ms: vals.length > 0 ? percentile(vals, 90) : null,
      };
    });

    return c.json({ buckets });
  });

  // GET /api/issues/:id/showdown — get active showdown for this issue
  router.get("/:id/showdown", async (c) => {
    const issueId = c.req.param("id");
    const result = await showdownService.getShowdownByIssue(issueId);
    if (!result) return c.json({ error: "No showdown found for this issue" }, 404);
    return c.json(result);
  });

  return router;
}

export const issuesRoute = createIssuesRoute(db, {});
