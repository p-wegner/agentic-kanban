import type { SessionManager } from "../services/session.manager.js";
import type { BoardEventSink } from "../services/board-events.js";
import type { Database } from "../db/index.js";
import { createWorkspaceService } from "../services/workspace.service.js";
import type { CreateWorkspaceInput } from "../services/workspace.service.js";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import {
  getProviderMixRows,
  getCostOverTimeRows,
  getScorecardScores,
  listWorkspacesSlim,
} from "../repositories/workspace.repository.js";
import {
  aggregateProviderMix,
  aggregateCostOverTime,
  bucketScorecardScores,
} from "../lib/workspace-stats.js";
import { clampDays, cutoffDayFor, subDays, buildDateAxis } from "../lib/analytics-window.js";
import { startCreateJob, completeCreateJob, failCreateJob, getCreateJob } from "../services/create-job.service.js";
import { conditionalJsonResponse } from "../services/board-etag-cache.service.js";
import { claimIssueForAutoStart } from "../services/auto-start-claim.js";
import { parseIssueRef } from "@agentic-kanban/shared/lib/issue-ref";
import { getIssueByNumberOrId } from "../repositories/issue/cli-commands.repository.js";
import { getPreference } from "../repositories/preferences.repository.js";


/**
 * Resolve the issue a create/preview call names, accepting `#N` / `42` as well as a UUID (#701).
 *
 * The one call that actually starts work took ONLY a UUID, while every human-facing surface —
 * CLAUDE.md, ticket titles, commit subjects, the CLI's own `issue get <N>` — names a ticket by
 * its number. So the documented spelling was the one spelling this endpoint rejected, and an
 * agent had to make a second round trip just to translate.
 *
 * Numbers are per-project (`MAX(issue_number) + 1`), so a numeric ref is only meaningful with a
 * project: the body's `projectId` wins, else the board's active project. That fallback is the
 * same one `create_issue` uses, and it is stated in the error when it produces the wrong answer
 * rather than being silent — resolving `#42` in an arbitrary project is exactly the #506 bug.
 */
async function resolveIssueIdFromBody(
  body: { issueId?: string; issueNumber?: string | number; projectId?: string },
  database: Database,
): Promise<{ ok: true; issueId: string } | { ok: false; status: 400 | 404; error: string }> {
  const raw = body.issueId ?? (body.issueNumber !== undefined ? String(body.issueNumber) : undefined);
  if (raw === undefined || raw === "") {
    return { ok: false, status: 400, error: "issueId (or issueNumber) is required" };
  }
  const ref = parseIssueRef(raw);
  // An id ref is passed through untouched: callers hand ids straight from the DB, and the
  // service already reports a missing issue. Only a NUMBER needs resolving here.
  if (ref.kind === "id") return { ok: true, issueId: ref.issueId };

  const projectId = body.projectId ?? (await getPreference("activeProjectId")) ?? undefined;
  if (!projectId) {
    return {
      ok: false,
      status: 400,
      error: `issueNumber ${ref.issueNumber} needs a project: issue numbers are per-project, and no projectId was given and no active project is set. Pass projectId, or pass the issue's id.`,
    };
  }
  const issue = await getIssueByNumberOrId(String(ref.issueNumber), projectId, database);
  if (!issue) {
    return {
      ok: false,
      status: 404,
      error: `No issue #${ref.issueNumber} in project ${projectId}. Issue numbers are per-project — it may exist in another project.`,
    };
  }
  return { ok: true, issueId: issue.id };
}

export function createWorkspacesRoute(
  database: Database,
  getSessionManager?: () => SessionManager,
  options?: { boardEvents?: BoardEventSink },
) {
  const router = createRouter();

  const workspaceService = createWorkspaceService({
    database,
    getSessionManager,
    boardEvents: options?.boardEvents,
  });

  // GET /api/workspaces/provider-mix?projectId=&days= — workspaces grouped by provider+profile per day
  // Must be registered BEFORE /:id to avoid being matched as an ID param
  router.get("/provider-mix", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "projectId required" }, 400);
    const days = clampDays(c.req.query("days"), 14);
    const now = new Date();

    const rows = await getProviderMixRows(projectId, cutoffDayFor(now, days), database);
    const dates = buildDateAxis(subDays(now, days - 1), now);
    return c.json(aggregateProviderMix(rows, dates));
  });

  // GET /api/workspaces/cost-over-time?projectId=&days= — estimated token cost per provider per day
  // Complements provider-mix (share of work) by showing the cost *trend* over time. Cost is read
  // from each session's persisted `stats.totalCostUsd`; the provider comes from the session's
  // workspace. Must be registered BEFORE /:id to avoid being matched as an ID param.
  router.get("/cost-over-time", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "projectId required" }, 400);
    const days = clampDays(c.req.query("days"), 30);

    // Start-of-UTC-day cutoff so the day buckets (ISO date keys) line up with the filter.
    // (Deliberately UTC-anchored, unlike the local-day analytics-window helpers used
    // elsewhere — cost buckets key on UTC ISO days, so the cutoff must match.)
    const cutoffDate = new Date();
    cutoffDate.setUTCDate(cutoffDate.getUTCDate() - days + 1);
    cutoffDate.setUTCHours(0, 0, 0, 0);
    const cutoffIso = cutoffDate.toISOString();

    const rows = await getCostOverTimeRows(projectId, cutoffIso, database);

    // Build a continuous UTC-day axis from the cutoff through today.
    const today = new Date();
    const dates: string[] = [];
    for (let d = new Date(cutoffDate); d <= today; d.setUTCDate(d.getUTCDate() + 1)) {
      dates.push(d.toISOString().slice(0, 10));
    }

    return c.json(aggregateCostOverTime(rows, dates));
  });

  // GET /api/workspaces/scorecard-distribution?projectId=&days= — scorecard score histogram (5 buckets: 0-20, 20-40, 40-60, 60-80, 80-100)
  // Must be registered BEFORE /:id to avoid being matched as an ID param
  router.get("/scorecard-distribution", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "projectId required" }, 400);
    const days = clampDays(c.req.query("days"), 90);

    const rows = await getScorecardScores(projectId, cutoffDayFor(new Date(), days), database);
    return c.json(bucketScorecardScores(rows));
  });

  // GET /api/workspaces/stale-worktrees — list closed workspaces with directories still on disk
  // Must be registered BEFORE /:id to avoid being matched as an ID param
  router.get("/stale-worktrees", async (c) => {
    const projectId = c.req.query("projectId") || undefined;
    const staleWorktrees = await workspaceService.listStaleWorktrees(projectId);
    return c.json(staleWorktrees);
  });

  // GET /api/workspaces/cleanup-warnings — list closed workspaces with pending cleanup warnings
  // Must be registered BEFORE /:id to avoid being matched as an ID param
  router.get("/cleanup-warnings", async (c) => {
    const projectId = c.req.query("projectId") || undefined;
    const warnings = await workspaceService.listCleanupWarnings(projectId);
    return c.json(warnings);
  });

  // POST /api/workspaces/preview — dry-run preview (read-only, no side effects)
  // Must be registered BEFORE /:id to avoid being matched as an ID param
  router.post("/preview", async (c) => {
    const body = await parseJsonBody<{
      issueId?: string;
      /** #701: `#N` / `42` alternative to `issueId`; resolved against `projectId` or the active project. */
      issueNumber?: string | number;
      /** Scopes a numeric `issueId`/`issueNumber` — issue numbers are per-project. */
      projectId?: string;
      branch?: string;
      isDirect?: boolean;
      baseBranch?: string;
      requiresReview?: boolean;
      thoroughReview?: boolean;
      planMode?: boolean;
      tddMode?: boolean;
      includeVisualProof?: boolean;
      skipSetup?: boolean;
      installMode?: "sequential" | "parallel" | "background";
      customPrompt?: string;
      clarifications?: string;
      skillId?: string;
      skillName?: string;
      profile?: { provider?: string; name?: string };
      claudeProfile?: string;
      model?: string;
      skipContextPacker?: boolean;
      repoScope?: string[];
    }>(c);
    const previewRef = await resolveIssueIdFromBody(body, database);
    if (!previewRef.ok) {
      return c.json({ error: previewRef.error }, previewRef.status);
    }

    const result = await workspaceService.computeLaunchPreview({
      issueId: previewRef.issueId,
      branch: body.branch,
      isDirect: body.isDirect === true,
      baseBranch: body.baseBranch,
      requiresReview: body.requiresReview === true,
      thoroughReview: body.thoroughReview === true,
      planMode: body.planMode,
      tddMode: body.tddMode === true,
      includeVisualProof: body.includeVisualProof === true,
      skipSetup: body.skipSetup === true,
      installMode: body.installMode,
      customPrompt: body.customPrompt,
      clarifications: body.clarifications,
      skillId: body.skillId,
      skillName: body.skillName,
      profile: body.profile,
      claudeProfile: body.claudeProfile,
      model: body.model,
      skipContextPacker: body.skipContextPacker === true,
      repoScope: Array.isArray(body.repoScope) ? body.repoScope : undefined,
    } satisfies CreateWorkspaceInput);
    return c.json(result);
  });

  // GET /api/workspaces?projectId= — flat project-scoped workspace list (slim: id/status/readyForMerge/issueId/branch/provider)
  // GET /api/workspaces?issueId= — workspaces for a single issue (same shape, no join needed)
  // Optional: status=active,idle (comma-separated), limit=N, offset=N
  router.get("/", async (c) => {
    const projectId = c.req.query("projectId");
    const issueId = c.req.query("issueId");

    if (!projectId && !issueId) {
      return c.json({ error: "projectId or issueId required" }, 400);
    }

    const statusParam = c.req.query("status");
    const statusFilter = statusParam
      ? statusParam.split(",").map((s) => s.trim()).filter(Boolean)
      : null;

    const limitParam = c.req.query("limit");
    const offsetParam = c.req.query("offset");
    // #511 deliberately does NOT use queryInt here: absent limit/offset must stay
    // `undefined` (meaning "no pagination"), which is a third state queryInt cannot
    // express — it always returns a number. Converting these would silently impose a
    // default page size on every unpaginated caller.
    const limitParsed = limitParam ? parseInt(limitParam, 10) : NaN;
    const offsetParsed = offsetParam ? parseInt(offsetParam, 10) : NaN;
    const limit = !isNaN(limitParsed) ? Math.max(1, limitParsed) : undefined;
    const offset = !isNaN(offsetParsed) ? Math.max(0, offsetParsed) : undefined;

    // Slim projection lives in the repository (listWorkspacesSlim). issueId takes
    // precedence (no join); otherwise scope by projectId through the issues join.
    // The projection surfaces model + mergedAt/isDirect alongside provider so an
    // agent reading the list API sees real model ids (#819) and merge state (#827).
    const rows = await listWorkspacesSlim(
      { issueId: issueId ?? undefined, projectId: projectId ?? undefined, statusFilter, limit, offset },
      database,
    );
    // Conditional GET: content-hash ETag over the serialized list, 304 with no
    // body when the client's If-None-Match still matches (frequent polls).
    return conditionalJsonResponse(JSON.stringify(rows), c.req.header("if-none-match"));
  });

  // GET /api/workspaces/create-jobs/:jobId — the tracked state of an async workspace
  // creation started with `POST /api/workspaces?async=1`. `null` means this process has
  // no record (unknown id, evicted, or the server restarted mid-create).
  // Must be registered BEFORE /:id to avoid `create-jobs` being matched as an ID param.
  router.get("/create-jobs/:jobId", (c) => {
    const jobId = c.req.param("jobId");
    const job = getCreateJob(jobId);
    if (!job) return c.json({ job: null, message: "no create job with this id in the current server process" });
    return c.json({ job });
  });

  // POST /api/workspaces — create workspace with worktree + auto-launch agent.
  //
  // Provisioning (worktree + branch, per-worktree dependency install, sibling-repo
  // worktrees, context packer) is minutes-long on real projects (#269: measured 514s
  // total, worktree-setup alone 294s), so `?async=1` records the creation as a job
  // (create-job.service.ts) and returns `202 + jobId` immediately; poll
  // GET /api/workspaces/create-jobs/:jobId for the verdict. The default stays
  // SYNCHRONOUS for back-compat — the UI, CLI, and MCP all read branch/workingDir
  // from this response body today.
  router.post("/", async (c) => {
    const body = await parseJsonBody<{
      issueId?: string;
      /** #701: `#N` / `42` alternative to `issueId`; resolved against `projectId` or the active project. */
      issueNumber?: string | number;
      /** Scopes a numeric `issueId`/`issueNumber` — issue numbers are per-project. */
      projectId?: string;
      branch?: string;
      isDirect?: boolean;
      baseBranch?: string;
      requiresReview?: boolean;
      thoroughReview?: boolean;
      planMode?: boolean;
      tddMode?: boolean;
      includeVisualProof?: boolean;
      skipSetup?: boolean;
      installMode?: "sequential" | "parallel" | "background";
      customPrompt?: string;
      clarifications?: string;
      skillId?: string;
      skillName?: string;
      profile?: { provider?: string; name?: string };
      claudeProfile?: string;
      model?: string;
      skipContextPacker?: boolean;
      repoScope?: string[];
      memberIssueIds?: string[];
    }>(c);
    const isDirect = body.isDirect === true;
    const createRef = await resolveIssueIdFromBody(body, database);
    if (!createRef.ok) {
      return c.json({ error: createRef.error }, createRef.status);
    }
    // Ticket group (#661): additional issues served by this one workspace.
    const memberIssueIds = Array.isArray(body.memberIssueIds)
      ? body.memberIssueIds.filter((v): v is string => typeof v === "string" && v.length > 0)
      : undefined;

    const input = {
      issueId: createRef.issueId,
      branch: body.branch,
      isDirect,
      baseBranch: body.baseBranch,
      requiresReview: body.requiresReview === true,
      thoroughReview: body.thoroughReview === true,
      planMode: body.planMode === true,
      tddMode: body.tddMode === true,
      includeVisualProof: body.includeVisualProof === true,
      skipSetup: body.skipSetup === true,
      installMode: body.installMode,
      customPrompt: body.customPrompt,
      clarifications: body.clarifications,
      skillId: body.skillId,
      skillName: body.skillName,
      profile: body.profile,
      claudeProfile: body.claudeProfile,
      model: body.model,
      skipContextPacker: body.skipContextPacker === true,
      repoScope: Array.isArray(body.repoScope) ? body.repoScope : undefined,
      memberIssueIds,
    } satisfies CreateWorkspaceInput;

    const wantsAsync = ["1", "true", "yes"].includes((c.req.query("async") || "").toLowerCase());
    if (wantsAsync) {
      // #366 — `?autoStart=1` marks the caller as an AUTOMATIC starter (today: the monitor's
      // auto-start passes). Automatic starters must be mutually exclusive per issue: the
      // workspace row lands only at the END of provisioning, so the table-based
      // "does this issue already have a workspace?" check every starter used is blind for
      // minutes, and two starters both read "no workspace" and both provisioned. Measured
      // live: one issue with two workspaces sharing a worktree, another with three rows
      // across two branch slugs, two agent runs stranded on an unmerged branch.
      //
      // The claim is taken HERE rather than in the caller so the check and the registration
      // stay in one synchronous pair (atomic on a single-threaded loop) — a caller that
      // checked and then did an `await fetch` would race again. Deliberate multi-workspace
      // creation (human New Workspace, provider showdown, scheduled runs) does NOT pass the
      // flag and is unaffected.
      const isAutoStarter = ["1", "true", "yes"].includes((c.req.query("autoStart") || "").toLowerCase());
      const job = isAutoStarter ? claimIssueForAutoStart(input.issueId) : startCreateJob(input.issueId);
      if (!job) {
        return c.json(
          { accepted: false, issueId: input.issueId, reason: "create_in_flight", error: "A workspace creation is already in flight for this issue" },
          409,
        );
      }
      // Ticket group (#661): an automatic starter claims every MEMBER too — a member is
      // otherwise invisible to the table-based checks for the whole provisioning window,
      // exactly the #366 blindness the lead's claim closes. A member whose claim fails
      // (another starter is provisioning it) is DROPPED from the group rather than
      // failing the whole create.
      const memberJobs: Array<{ jobId: string }> = [];
      if (isAutoStarter && input.memberIssueIds && input.memberIssueIds.length > 0) {
        const claimed: string[] = [];
        for (const memberId of input.memberIssueIds) {
          const memberJob = claimIssueForAutoStart(memberId);
          if (memberJob) {
            memberJobs.push(memberJob);
            claimed.push(memberId);
          } else {
            console.log(`[workspaces] ticket-group member ${memberId} dropped — a workspace creation is already in flight for it (#366)`);
          }
        }
        input.memberIssueIds = claimed;
      }
      // Nothing awaits this promise; the job record IS the report. createWorkspace
      // resolves with status:"error" for most failures (completeCreateJob maps that to
      // a failed job) and only throws WorkspaceErrors (failCreateJob path).
      void workspaceService
        .createWorkspace(input)
        .then((result) => {
          completeCreateJob(job.jobId, result);
          for (const memberJob of memberJobs) completeCreateJob(memberJob.jobId, result);
        })
        .catch((err: unknown) => {
          failCreateJob(job.jobId, err);
          for (const memberJob of memberJobs) failCreateJob(memberJob.jobId, err);
        });
      return c.json(
        { accepted: true, jobId: job.jobId, issueId: input.issueId, statusUrl: `/api/workspaces/create-jobs/${job.jobId}` },
        202,
      );
    }

    const result = await workspaceService.createWorkspace(input);
    return c.json(result, 201);
  });

  // GET /api/workspaces/:id
  router.get("/:id", async (c) => {
    const id = c.req.param("id");
    const details = await workspaceService.getWorkspace(id);
    if (!details) {
      return c.json({ error: "Workspace not found" }, 404);
    }
    return c.json(details);
  });

  // GET /api/workspaces/:id/dev-server-plan — the honest dev-server plan (command / health
  // URL / port + provenance) the board would boot for this workspace's project. The
  // diagnostics tab renders this instead of assuming the app's own 3001/5173 worktree
  // ports, which are wrong for any other project (docker-compose / multi-repo, #100).
  router.get("/:id/dev-server-plan", async (c) => {
    const id = c.req.param("id");
    const result = await workspaceService.getWorkspaceDevServerPlan(id);
    if (!result) {
      return c.json({ error: "Workspace not found" }, 404);
    }
    return c.json(result);
  });

  // PATCH /api/workspaces/:id
  router.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const body = await parseJsonBody(c);
    const result = await workspaceService.updateWorkspace(id, body);
    return c.json(result);
  });

  // POST /api/workspaces/:id/ready-for-merge — mark workspace as reviewed and ready to merge
  router.post("/:id/ready-for-merge", async (c) => {
    const id = c.req.param("id");
    const result = await workspaceService.markReadyForMerge(id);
    return c.json(result);
  });

  // POST /api/workspaces/:id/close — close without merging (abandoned or already-merged work)
  router.post("/:id/close", async (c) => {
    const id = c.req.param("id");
    const result = await workspaceService.closeWorkspace(id);
    return c.json(result);
  });

  // DELETE /api/workspaces/:id — cascade delete sessions and their messages
  router.delete("/:id", async (c) => {
    const id = c.req.param("id");
    await workspaceService.deleteWorkspace(id);
    return c.json({ success: true });
  });

  return router;
}
