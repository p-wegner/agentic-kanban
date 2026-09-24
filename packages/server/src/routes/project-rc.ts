import type { Database } from "../db/index.js";
import type { SessionManager } from "../services/session.manager.js";
import type { BoardEventSink } from "../services/board-events.js";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { rcMergeBackBody, rcRetargetBody } from "./project-rc-body-schemas.js";
import { getProjectById } from "../repositories/project.repository.js";
import { createWorkspaceService } from "../services/workspace.service.js";
import { createRcMergeBackWorkspace, MergeBackError } from "../services/rc-merge-back.service.js";
import { listOpenRcHealTickets, retargetRcHealTickets } from "../services/rc-heal-ticket.service.js";
import { withRcHeal } from "../services/delivery-status.service.js";
import { currentRcCandidate, readRcState, resolveStableCheckoutFor, toRcCandidateSummary } from "../services/rc-state.js";
import { isRcBranch } from "../services/heal-gate-forcing.js";

/**
 * The release-candidate endpoints `pnpm promote` and the Sentinel talk to (#1239, decision 019).
 * Mounted at the same `/projects` prefix as the health routes.
 *
 *  - `GET  /:id/rc`             — the current candidate with its open heal tickets listed.
 *  - `POST /:id/rc/merge-back`  — create (or return) the merge-back workspace for a promoted rc.
 *  - `POST /:id/rc/retarget`    — move an abandoned rc's open heal tickets to the next candidate.
 *
 * A branch that is not `rc/<date>[-N]` is refused with 400 before anything is looked up.
 */
export function createProjectRcRoute(
  database: Database,
  getSessionManager: () => SessionManager,
  options?: { boardEvents?: BoardEventSink },
) {
  const router = createRouter();
  const workspaceService = createWorkspaceService({ database, getSessionManager, boardEvents: options?.boardEvents });

  // GET /api/projects/:id/rc
  router.get("/:id/rc", async (c) => {
    const projectId = c.req.param("id");
    const project = await getProjectById(projectId, database);
    if (!project) return c.json({ error: "not found" }, 404);
    const rc = await withRcHeal(projectId, toRcCandidateSummary(currentRcCandidate(readRcState(resolveStableCheckoutFor(project.repoPath)))), database);
    const healTickets = rc ? await listOpenRcHealTickets(projectId, rc.branch, database) : [];
    return c.json({
      rc,
      healTickets: healTickets.map((t) => ({ issueId: t.id, issueNumber: t.issueNumber, title: t.title, externalKey: t.externalKey })),
    });
  });

  // POST /api/projects/:id/rc/merge-back
  router.post("/:id/rc/merge-back", async (c) => {
    const projectId = c.req.param("id");
    const body = await parseJsonBody(c, rcMergeBackBody);
    const branch = (body.branch ?? "").trim();
    if (!isRcBranch(branch)) return c.json({ error: "branch must be a release-candidate branch (rc/<date>[-N])" }, 400);
    try {
      const result = await createRcMergeBackWorkspace(
        { projectId, rcBranch: branch, tag: body.tag ?? null },
        { database, createWorkspace: (input) => workspaceService.createWorkspace(input) },
      );
      return c.json(result, result.created ? 201 : 200);
    } catch (err) {
      if (err instanceof MergeBackError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  // POST /api/projects/:id/rc/retarget
  router.post("/:id/rc/retarget", async (c) => {
    const projectId = c.req.param("id");
    const body = await parseJsonBody(c, rcRetargetBody);
    const from = (body.from ?? "").trim();
    const to = (body.to ?? "").trim();
    if (!isRcBranch(from) || !isRcBranch(to) || from === to) {
      return c.json({ error: "from and to must be two different release-candidate branches (rc/<date>[-N])" }, 400);
    }
    const project = await getProjectById(projectId, database);
    if (!project) return c.json({ error: "not found" }, 404);
    const result = await retargetRcHealTickets({ projectId, fromBranch: from, toBranch: to }, database);
    return c.json(result);
  });

  return router;
}
