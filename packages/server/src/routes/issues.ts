import type { Database } from "../db/index.js";
import type { BoardEventSink } from "../services/board-events.js";
import type { SessionManager } from "../services/session.manager.js";
import { analyzeDependencies, enhanceIssue, aiEstimateIssue, decomposeEpic, confirmEpicDecomposition, contractCoupledComponent, confirmContractComponent, analyzeTouchedFiles } from "../services/issue-ai.service.js";
import { scanForTicketGroups, scanTouchedFilesForTicketGroups } from "../services/ticket-group-scan.service.js";
import type { DecomposeChildProposal, DecomposeDependencyProposal } from "../services/issue-ai.service.js";
import { createIssueService } from "../services/issue.service.js";
import type { CreateIssueInput, BatchDependencyInput } from "../services/issue.service.js";
import {
  getIssueDescription,
  getIssueTouchedFiles,
  getIssueTouchedFilesWithProject,
  getProjectIssuesTouchedFiles,
} from "../repositories/issue.repository.js";
import { clampDays } from "../lib/analytics-window.js";

/**
 * Upper bound for `GET /api/issues?limit=` (#424). A caller asking for more gets this
 * many rather than an error — the point is to bound the response, not to police the
 * request. Unpaginated calls (no `limit`) are unaffected and still return everything,
 * which keeps every existing consumer working.
 */
const MAX_ISSUE_PAGE_SIZE = 500;
import {
  getBurndownChart,
  getCfdChart,
  getThroughputChart,
  getLeadTimeChart,
} from "../services/issue-analytics.service.js";
import { createIssueCommentsService } from "../services/issue-comments.service.js";
import { createIssueTimeEntriesService } from "../services/issue-time-entries.service.js";
import type { IssueCommentKind, IssueCommentAuthor } from "../repositories/issue-comments.repository.js";
import { createShowdownService } from "../services/showdown.service.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import {
  enhanceIssueBody, analyzeDependenciesBody, aiEstimateBody, projectIdBody,
  decomposeConfirmBody, contractConfirmBody, groupScanBody, batchIssuesBody, dependenciesBatchBody,
  contractCoupledBody, bulkUpdateBody,
  archiveDoneBody, createIssueBody, analyzeTouchedFilesBody, preflightBody, reposTouchedBody,
  issueTagBody, issueDependencyBody, issueArtifactBody, issueCommentBody, showdownBody,
} from "./issue-body-schemas.js";
import { createRouter } from "../middleware/create-router.js";
import { wrapAiOperation } from "../lib/ai-operation.js";
import { runTicketPreflight, formatClarificationsBlock, type PreflightVerdict } from "../services/ticket-preflight.service.js";
import { getPreference } from "../repositories/preferences.repository.js";
import { getBool } from "@agentic-kanban/shared/lib/settings-registry";
import { getIssueActivity } from "../services/issue-activity.service.js";
import { createIssueMergedCommitsService } from "../services/issue-merged-commits.service.js";
import { getIssueCycleTime } from "../services/cycle-time.service.js";
import { createWebhookSender } from "../services/outbound-webhook.service.js";
import { conditionalJsonResponse } from "../services/board-etag-cache.service.js";

import { queryFlag } from "../middleware/query-params.js";
import { getActiveProjectIdPref } from "../repositories/board-status.repository.js";
import { setIssueReposTouched } from "../services/repo-tags.service.js";
import { getIssueById } from "../repositories/followup-workspace.repository.js";
export function createIssuesRoute(database: Database, options?: { boardEvents?: BoardEventSink; getSessionManager?: () => SessionManager }) {
  const router = createRouter();

  const issueService = createIssueService({ database, boardEvents: options?.boardEvents, sendWebhook: createWebhookSender(database) });
  const issueCommentsService = createIssueCommentsService({ database, boardEvents: options?.boardEvents });
  const timeEntriesService = createIssueTimeEntriesService({ database });
  const mergedCommitsService = createIssueMergedCommitsService({ database });
  const showdownService = createShowdownService({
    database,
    getSessionManager: options?.getSessionManager,
    boardEvents: options?.boardEvents,
  });

  // GET /api/issues?projectId=...&issueNumber=N&statusName=InProgress&slim=1
  // slim=1 omits the description field (the bulk of the payload) — opt-in,
  // default response shape unchanged.
  router.get("/", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "projectId query parameter required" }, 400);
    const issueNumberParam = c.req.query("issueNumber");
    const statusName = c.req.query("statusName") || undefined;
    const slim = queryFlag(c, "slim");
    // Pagination (#424): opt-in, so the default response is byte-identical to before.
    // `limit` is clamped rather than rejected — a caller asking for 10_000 wants "all
    // of it" and should get a bounded page, not a 400 it has to special-case.
    const limitParam = Number(c.req.query("limit"));
    const limit = Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(Math.floor(limitParam), MAX_ISSUE_PAGE_SIZE)
      : undefined;
    const offsetParam = Number(c.req.query("offset"));
    const offset = Number.isFinite(offsetParam) && offsetParam > 0 ? Math.floor(offsetParam) : undefined;

    const result = await issueService.listIssues(
      projectId,
      issueNumberParam ? Number(issueNumberParam) : undefined,
      statusName,
      (slim || limit !== undefined)
        ? { excludeDescription: slim, limit, offset }
        : undefined,
    );
    // Conditional GET (#418, the #400 pattern): the full issue list is the largest payload in the
    // app (~1MB of descriptions on a big board) and mostly unchanged between polls — hash the
    // serialized body and answer 304 when If-None-Match matches.
    //
    // #426: the extra header goes through `conditionalJsonResponse`'s `extraHeaders`, NOT onto the
    // returned Response. A header set on a returned raw Response is silently dropped by Hono; only
    // what goes into the constructor's `init` survives. See that function for the measurement.
    const body = JSON.stringify(result);
    const extraHeaders = limit === undefined
      ? undefined
      // The denominator, so a paginating caller knows whether another page exists without fetching
      // one and finding it empty. A header keeps the body an array — turning it into
      // `{items,total}` would break every existing consumer.
      : { "X-Total-Count": String(await issueService.countIssues(projectId, statusName)) };
    return conditionalJsonResponse(body, c.req.header("if-none-match"), extraHeaders);
  });

  // POST /api/issues/enhance — AI-enhance a ticket title and description
  router.post("/enhance", async (c) => {
    const body = await parseJsonBody(c, enhanceIssueBody);
    return c.json(await wrapAiOperation("enhance", () => enhanceIssue(body.title, body.description, database)));
  });

  // POST /api/issues/analyze-dependencies — AI-analyze dependencies for an issue
  router.post("/analyze-dependencies", async (c) => {
    const body = await parseJsonBody(c, analyzeDependenciesBody);
    const result = await wrapAiOperation("analyze-deps", () => analyzeDependencies(body.issueId, body.projectId, database));
    if (result.total > 0) options?.boardEvents?.broadcast(body.projectId, "dependency_added");
    return c.json(result);
  });

  // POST /api/issues/ai-estimate — AI-suggest a T-shirt size estimate for an issue
  router.post("/ai-estimate", async (c) => {
    const body = await parseJsonBody(c, aiEstimateBody);
    return c.json(await wrapAiOperation("ai-estimate", () => aiEstimateIssue(body.issueId, database)));
  });

  // POST /api/issues/:id/decompose — AI-generate epic decomposition proposal
  router.post("/:id/decompose", async (c) => {
    const issueId = c.req.param("id");
    const body = await parseJsonBody(c, projectIdBody);
    return c.json(await wrapAiOperation("decompose", () => decomposeEpic(issueId, body.projectId, database)));
  });

  // POST /api/issues/:id/decompose/confirm — confirm epic decomposition and create child issues
  router.post("/:id/decompose/confirm", async (c) => {
    const issueId = c.req.param("id");
    const body = await parseJsonBody(c, decomposeConfirmBody);
    const result = await confirmEpicDecomposition(
      { issueId, projectId: body.projectId, children: body.children as DecomposeChildProposal[], dependencies: body.dependencies as DecomposeDependencyProposal[], driveTarget: body.driveTarget },
      database,
    );
    options?.boardEvents?.broadcast(body.projectId, "issue_created");
    return c.json(result, 201);
  });

  // POST /api/issues/contract — propose contracting coupled components into single tickets.
  // The documented INVERSE of /decompose: decompose splits one epic into many; contract
  // collapses a coupled component (coupled_with peers) back into one. Propose-only.
  router.post("/contract", async (c) => {
    const body = await parseJsonBody(c, projectIdBody);
    return c.json(await wrapAiOperation("contract", () => contractCoupledComponent(body.projectId, database)));
  });

  // POST /api/issues/contract/confirm — apply a contract proposal (keep survivor, absorb the rest).
  router.post("/contract/confirm", async (c) => {
    const body = await parseJsonBody(c, contractConfirmBody);
    const result = await confirmContractComponent(
      { projectId: body.projectId, survivorId: body.survivorId, memberIds: body.memberIds, mergedTitle: body.mergedTitle, mergedDescription: body.mergedDescription ?? "" },
      database,
    );
    options?.boardEvents?.broadcast(body.projectId, "board_changed");
    return c.json(result);
  });

  // POST /api/issues/group-scan — propose ticket GROUPS over the open backlog (#661).
  // The non-destructive sibling of /contract: applying writes `coupled_with` edges only
  // (every ticket keeps its identity); the monitor's auto-group start then executes each
  // group as ONE workspace. Preview by default; `apply: true` creates the edges.
  // `mode: "touched-files"` (#918) is the deterministic seed for a cold backlog — no LLM
  // call, grouped by shared predicted files (excluding hot/registration files).
  router.post("/group-scan", async (c) => {
    const body = await parseJsonBody(c, groupScanBody);
    const projectId = body.projectId;
    const apply = body.apply === true;
    const result = body.mode === "touched-files"
      ? await scanTouchedFilesForTicketGroups(projectId, database, { apply, minSharedFiles: body.minSharedFiles })
      : await wrapAiOperation("group-scan", () => scanForTicketGroups(projectId, database, { apply }));
    if (apply) options?.boardEvents?.broadcast(projectId, "dependency_added");
    return c.json(result);
  });

  // POST /api/issues/batch — create N issues atomically
  // Optional: parentIssueId wires child_of edges; driveTarget (requires parentIssueId) auto-creates a Drive record.
  router.post("/batch", async (c) => {
    const body = await parseJsonBody(c, batchIssuesBody);
    const result = await issueService.createIssuesBatch(body.projectId, body.issues as Omit<CreateIssueInput, "projectId">[], {
      parentIssueId: body.parentIssueId,
      driveTarget: body.driveTarget,
      dependencies: body.dependencies as BatchDependencyInput[] | undefined,
    });
    return c.json(result, 201);
  });

  // POST /api/issues/dependencies/batch — add/remove N dependency edges atomically
  router.post("/dependencies/batch", async (c) => {
    const body = await parseJsonBody(c, dependenciesBatchBody);
    const result = await issueService.updateDependenciesBatch(body.edges as { issueId: string; dependsOnId: string; type?: string; action: "add" | "remove" }[]);
    return c.json({ added: result.added, removed: result.removed, skipped: result.skipped });
  });

  // POST /api/issues/contract-coupled — contract a full coupled_with component onto one lead.
  router.post("/contract-coupled", async (c) => {
    const body = await parseJsonBody(c, contractCoupledBody);
    const result = await issueService.contractCoupledIssues(body.issueIds, body.leadIssueId);
    return c.json({
      leadIssueId: result.leadIssueId,
      memberIssueIds: result.memberIssueIds,
      mutations: result.mutations,
      added: result.added,
      removed: result.removed,
      skipped: result.skipped,
    });
  });

  // POST /api/issues/archive-done — move Done issues older than N days to Archived
  router.post("/archive-done", async (c) => {
    const body = await parseJsonBody(c, archiveDoneBody);
    // `olderThanDays` stays a COERCION, not a schema field — see `archiveDoneBody`.
    const days = Number(body.olderThanDays);
    if (!Number.isFinite(days) || days <= 0) {
      return c.json({ error: "olderThanDays must be a positive number" }, 400);
    }
    const result = await issueService.archiveDoneIssues(body.projectId, days, body.nowOverride);
    return c.json({ archived: result.archived });
  });

  // PATCH /api/issues/bulk - update N issues in one request
  router.patch("/bulk", async (c) => {
    const body = await parseJsonBody(c, bulkUpdateBody);
    const result = await issueService.updateIssuesBulk(body.issueIds, body.updates);
    return c.json({ updated: result.updated });
  });

  // POST /api/issues
  router.post("/", async (c) => {
    const body = await parseJsonBody(c, createIssueBody);

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
      reposTouched: Array.isArray(body.reposTouched) ? body.reposTouched : undefined,
    });
    return c.json(result, 201);
  });

  // Cached touched-files prediction for one issue, or null when the issue doesn't
  // exist. Shared by the standalone endpoint and the detail-bundle (#418).
  async function readTouchedFiles(issueId: string): Promise<{ files: unknown[]; cached: boolean } | null> {
    const row = await getIssueTouchedFiles(issueId, database);
    if (!row) return null;
    const json = row.touchedFilesJson;
    let files: unknown[] = [];
    if (json) {
      try { files = JSON.parse(json) as unknown[]; } catch { files = []; }
    }
    return { files, cached: true };
  }

  // File-overlap scan against the project's other issues, or null when the issue
  // doesn't exist. Shared by the standalone endpoint and the detail-bundle (#418).
  async function computeRelatedIssues(
    issueId: string,
  ): Promise<{ related: { id: string; issueNumber: number | null; title: string; sharedFileCount: number }[] } | null> {
    const row = await getIssueTouchedFilesWithProject(issueId, database);
    if (!row) return null;
    const json = row.touchedFilesJson;
    if (!json) return { related: [] };
    let myFiles: { path: string }[] = [];
    try { myFiles = JSON.parse(json) as { path: string }[]; } catch { return { related: [] }; }
    const myPaths = new Set(myFiles.map((f) => f.path));
    if (myPaths.size === 0) return { related: [] };

    const candidates = await getProjectIssuesTouchedFiles(row.projectId, database);

    const related: { id: string; issueNumber: number | null; title: string; sharedFileCount: number }[] = [];
    for (const candidate of candidates) {
      if (candidate.id === issueId) continue;
      if (!candidate.touchedFilesJson) continue;
      let candidateFiles: { path: string }[] = [];
      try { candidateFiles = JSON.parse(candidate.touchedFilesJson) as { path: string }[]; } catch { continue; }
      const sharedCount = candidateFiles.filter((f) => myPaths.has(f.path)).length;
      if (sharedCount > 0) {
        related.push({ id: candidate.id, issueNumber: candidate.issueNumber, title: candidate.title, sharedFileCount: sharedCount });
      }
    }
    related.sort((a, b) => b.sharedFileCount - a.sharedFileCount);
    return { related };
  }

  // GET /api/issues/:id/touched-files — return cached prediction only (no AI call)
  router.get("/:id/touched-files", async (c) => {
    const issueId = c.req.param("id");
    const result = await readTouchedFiles(issueId);
    if (!result) return c.json({ error: "Issue not found" }, 404);
    return c.json(result);
  });

  // POST /api/issues/:id/analyze-touched-files — run (or re-run) AI prediction
  router.post("/:id/analyze-touched-files", async (c) => {
    const issueId = c.req.param("id");
    const body = await parseJsonBody(c, analyzeTouchedFilesBody).catch(() => ({ refresh: false }));
    return c.json(await wrapAiOperation("analyze-touched-files", () => analyzeTouchedFiles(issueId, database, body?.refresh === true)));
  });

  // GET /api/issues/:id/related-issues — find other issues that share touched files with this one
  router.get("/:id/related-issues", async (c) => {
    const issueId = c.req.param("id");
    const result = await computeRelatedIssues(issueId);
    if (!result) return c.json({ error: "Issue not found" }, 404);
    return c.json(result);
  });


  // POST /api/issues/:id/preflight — AI ticket sanity check.
  // Optional `clarifications` (answered preflight questions): when present, they are
  // persisted as a durable `preflight-clarification` comment and folded into the prompt
  // for the re-check. The returned `clarificationsBlock` is the markdown the caller can
  // prepend to the launching agent's context.
  router.post("/:id/preflight", async (c) => {
    const issueId = c.req.param("id");
    const body = await parseJsonBody(c, preflightBody);

    // `skip_preflight` is enforced HERE, not only in the client. The launch form was the
    // sole gate, so every other caller (CLI, MCP, butler, a second tab) still paid for the
    // AI check after the operator turned it off. Report the skip in the verdict instead of
    // faking a "ready" the model never produced.
    const preflightPrefs = { skip_preflight: (await getPreference("skip_preflight", database)) ?? undefined };
    if (getBool(preflightPrefs, "skip_preflight")) {
      return c.json({
        verdict: "ready" satisfies PreflightVerdict,
        questions: [],
        summary: "Preflight is disabled (skip_preflight); no check was run.",
        looksComplex: false,
        skipped: true,
      });
    }

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

  // GET /api/issues/:id/merged-commits — commits that landed on the default branch for this issue
  router.get("/:id/merged-commits", async (c) => {
    const issueId = c.req.param("id");
    const result = await mergedCommitsService.getMergedCommits(issueId);
    if (!result) return c.json({ error: "Issue not found" }, 404);
    return c.json(result);
  });

  // GET /api/issues/:id/detail-bundle — one round-trip for the IssueDetailPanel.
  // Collapses the per-issue fetches (issue+description, workspaces, tags,
  // dependencies, artifacts, comments, activity) the panel otherwise fires as
  // ~7 separate requests, which queue behind the browser's 6-connection
  // HTTP/1.1 limit (head-of-line blocking — the same problem /settings-bootstrap
  // solved for the settings panel). #418 folds in the remaining per-issue fetches
  // the panel used to fire separately (cycle-time, time-entries, touched-files,
  // related-issues, merged-commits — ~5 more requests per open). Project-scoped
  // data (all tags, skills, milestones, available issues) stays on its own
  // cacheable endpoints, and the individual per-issue endpoints stay alive for
  // other callers (MCP/CLI/mutation refetches). Each sub-result is independent:
  // a failure degrades that field rather than failing the bundle.
  router.get("/:id/detail-bundle", async (c) => {
    const id = c.req.param("id");
    const issue = await getIssueDescription(id, database);
    if (!issue) return c.json({ error: "Issue not found" }, 404);
    const [workspaces, tags, dependencies, artifacts, comments, activity, cycleTime, timeEntries, touchedFiles, relatedIssues, mergedCommits] = await Promise.all([
      Promise.resolve(issueService.getEnrichedWorkspaces(id)).catch(() => []),
      Promise.resolve(issueService.getTags(id)).catch(() => []),
      Promise.resolve(issueService.getDependencies(id)).catch(() => null),
      Promise.resolve(issueService.getArtifacts(id)).catch(() => []),
      Promise.resolve(issueCommentsService.listComments(id)).catch(() => []),
      Promise.resolve(getIssueActivity(id, database)).catch(() => null),
      Promise.resolve(getIssueCycleTime(id, database)).catch(() => null),
      Promise.all([timeEntriesService.listEntries(id), timeEntriesService.totalMinutes(id)])
        .then(([entries, totalMinutes]) => ({ entries, totalMinutes }))
        .catch(() => null),
      readTouchedFiles(id).catch(() => null),
      computeRelatedIssues(id).catch(() => null),
      Promise.resolve(mergedCommitsService.getMergedCommits(id)).catch(() => null),
    ]);
    return c.json({
      issue,
      workspaces,
      tags,
      dependencies,
      artifacts,
      comments,
      activity: activity ?? { events: [] },
      cycleTime,
      timeEntries,
      touchedFiles,
      relatedIssues,
      mergedCommits,
    });
  });

  // GET /api/issues/:id — returns the issue with its full description (used for lazy-loading)
  // GET /api/issues/burndown?projectId=&days= — burndown of remaining open issues per day.
  // "Remaining open" on day D = issues created by end of D that are NOT yet in a terminal
  // status (Done/Cancelled) by end of D. Returns one bucket per day in the trailing window
  // plus the window-start count (drives the ideal target trend line on the client). Distinct
  // from lead-time (#499): that measures creation→Done age; this measures remaining-work
  // velocity. Reopen cycles are not modelled — fidelity matches the lead-time route (uses
  // createdAt + current status + statusChangedAt).
  // Registered before the `/:id` catch-all: literal sub-paths must precede it or Hono's
  // order-sensitive router (fallback for this router's nested params) shadows them.
  router.get("/burndown", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "projectId required" }, 400);
    const days = clampDays(c.req.query("days"), 30);
    return c.json(await getBurndownChart(projectId, days, database));
  });

  // GET /api/issues/cfd?projectId=&days= — cumulative flow diagram data.
  // Returns one entry per (date, status) pair: the count of issues that were
  // in that status as of the end of that day (based on statusChangedAt or
  // createdAt when no explicit status change is recorded).
  router.get("/cfd", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "projectId required" }, 400);
    const days = clampDays(c.req.query("days"), 30);
    return c.json(await getCfdChart(projectId, days, database));
  });

  // GET /api/issues/throughput?projectId=&days= — daily throughput: count of issues moved to Done per calendar day.
  // Uses statusChangedAt to identify when issues entered the Done status.
  // Returns one data point per day for the trailing `days` window (default 14).
  router.get("/throughput", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "projectId required" }, 400);
    const days = clampDays(c.req.query("days"), 14);
    return c.json(await getThroughputChart(projectId, days, database));
  });

  // GET /api/issues/lead-time?projectId=&days= — lead time trend: median + p90 per day for issues that reached Done.
  // Lead time = Done statusChangedAt - createdAt (wall-clock age of the issue).
  // Returns one bucket per day in the trailing window; buckets with no completions have medianMs/p90Ms = null.
  router.get("/lead-time", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "projectId required" }, 400);
    const days = clampDays(c.req.query("days"), 30);
    return c.json(await getLeadTimeChart(projectId, days, database));
  });

  router.get("/:id", async (c) => {
    const id = c.req.param("id");
    const result = await getIssueDescription(id, database);
    if (!result) return c.json({ error: "Issue not found" }, 404);
    return c.json(result);
  });

  // GET /api/issues/:id/summary
  router.get("/:id/summary", async (c) => {
    const idParam = c.req.param("id");
    // #506: a bare issue NUMBER is only unique within a project, so scope it — explicit
    // ?projectId= wins, otherwise the active project (which is what the CLI already does).
    // Without this, `/api/issues/5/summary` returned whichever project's #5 the DB yielded
    // first; verified live on a 25-project board.
    const projectId = c.req.query("projectId") || (await getActiveProjectIdPref(database)) || undefined;
    const result = await issueService.getIssueSummary(idParam, projectId);
    if (!result) return c.json({ error: "Issue not found" }, 404);
    return c.json(result);
  });

  // PATCH /api/issues/:id
  router.patch("/:id", async (c) => {
    // #806 batch 3 REJECTED this read, deliberately: the body has no declared type and is
    // forwarded WHOLE to `updateIssue(id, body: Record<string, unknown>)`, which decides field
    // by field what it recognises. There is nothing to tighten TO — a schema here would have to
    // invent a field list (and 400 the fields it forgot) or check nothing and merely look
    // validated. Same argument as `PATCH /api/projects/:id` in batch 2.
    const id = c.req.param("id");
    const body = await parseJsonBody(c);
    const result = await issueService.updateIssue(id, body);
    return c.json(result);
  });

  // PUT /api/issues/:id/repos-touched — set the repos this issue declares it touches (#633).
  //
  // The create path could apply these and nothing could ever change them, so an issue filed
  // by anything other than the create panel (a plugin loop, the API, an import) had no repo
  // scope and no way to get one. Deliberately a SET, not an append: deselecting has to
  // remove, or the field is a one-way ratchet. Unknown names are dropped and the applied set
  // is echoed back, so a client can render what actually stuck.
  router.put("/:id/repos-touched", async (c) => {
    const id = c.req.param("id");
    const body = await parseJsonBody(c, reposTouchedBody);
    const [issue] = await getIssueById(id, database);
    if (!issue) return c.json({ error: "Issue not found" }, 404);
    const applied = await setIssueReposTouched(id, issue.projectId, body.reposTouched, database);
    options?.boardEvents?.broadcast(issue.projectId, "issue_updated");
    return c.json({ reposTouched: applied });
  });

  // POST /api/issues/:id/duplicate
  router.post("/:id/duplicate", async (c) => {
    const id = c.req.param("id");
    const result = await issueService.duplicateIssue(id);
    return c.json(result, 201);
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
    const body = await parseJsonBody(c, issueTagBody);
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
    const body = await parseJsonBody(c, issueDependencyBody);

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
    const body = await parseJsonBody(c, issueArtifactBody);

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

  // GET /api/issues/:id/comments — durable Q&A / activity thread for an issue.
  // CAPPED (#738): the newest page, ascending. `?limit=` narrows/widens it (hard ceiling in
  // the repository), `?before=<ISO>` is the keyset cursor for older pages. The response
  // carries `totalCount`/`hasMore`/`nextCursor` ALONGSIDE the unchanged `comments` array, so
  // an existing client keeps working and a paging one has what it needs.
  router.get("/:id/comments", async (c) => {
    const issueId = c.req.param("id");
    const limitParam = c.req.query("limit");
    const limit = limitParam === undefined ? undefined : Number(limitParam);
    const before = c.req.query("before") ?? null;
    const page = await issueCommentsService.listCommentsPage(issueId, { limit, before });
    return c.json(page);
  });

  // POST /api/issues/:id/comments
  router.post("/:id/comments", async (c) => {
    const issueId = c.req.param("id");
    const body = await parseJsonBody(c, issueCommentBody);
    /**
     * Deliberately NARROWER than ISSUE_COMMENT_KINDS (#569). `preflight-verdict` and
     * `gate-decision` are written by the server itself (routes/issues.ts:469 and
     * plugin-loop.service.ts) and are records of a machine decision — a human POSTing
     * one would be forging it, so they are not accepted here. This is a whitelist by
     * intent, not a copy of the vocabulary that fell behind.
     */
    const userPostableKinds: IssueCommentKind[] = ["preflight-clarification", "agent-question", "merge-attempt", "note"];
    const validAuthors: IssueCommentAuthor[] = ["user", "butler", "agent", "preflight", "system"];
    const kind = body.kind && userPostableKinds.includes(body.kind) ? body.kind : "note";
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
    // #806 batch 3 REJECTED this one: the only guard is a COERCION — `Number(body.minutes)`
    // then `Number.isInteger`, so the string `"30"` is a valid request today and a schema
    // that checked `minutes` would 400 it. Nothing else in the body is checked, so the
    // schema would be decoration that lowers a count without checking anything.
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
    const body = await parseJsonBody(c, showdownBody);
    const result = await showdownService.createShowdown(issueId, body.contestants);
    return c.json(result, 201);
  });

  // GET /api/issues/:id/showdown — get active showdown for this issue.
  // Returns 200 with `null` when none exists: most issues never have a showdown,
  // so "no showdown" is a normal state, not a client error. (A 404 here floods
  // the browser console with errors every time an issue detail panel opens.)
  router.get("/:id/showdown", async (c) => {
    const issueId = c.req.param("id");
    const result = await showdownService.getShowdownByIssue(issueId);
    return c.json(result ?? null);
  });

  return router;
}
