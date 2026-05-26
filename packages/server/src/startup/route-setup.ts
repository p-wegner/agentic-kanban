import { serveStatic } from "@hono/node-server/serve-static";
import { issues, preferences, projects, workspaces } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "../db/index.js";
import { createRoutes } from "../routes/index.js";
import { createSessionsRoute } from "../routes/sessions.js";
import { MOCK_AGENT_COMMAND, isMockProfile, toExecutorProvider } from "../services/agent-settings.service.js";
import type { createBoardEvents } from "../services/board-events.js";
import * as gitService from "../services/git.service.js";
import { createSessionManager } from "../services/session.manager.js";
import { buildReviewArgs, buildReviewPrompt, getEffectiveProfile, parseProviderPref } from "./review-helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface RouteSetupDeps {
  sessionManager: ReturnType<typeof createSessionManager>;
  boardEvents: ReturnType<typeof createBoardEvents>;
  reviewSessionIds: Set<string>;
  fixAndMergeSessionIds: Set<string>;
  db: Database;
}

export function setupRoutes(app: Hono, { sessionManager, boardEvents, reviewSessionIds, fixAndMergeSessionIds, db }: RouteSetupDeps) {
  app.post("/api/workspaces/:id/review", async (c) => {
    const workspaceId = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const thoroughReview = body.thoroughReview === true;
    const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    if (wsRows.length === 0) return c.json({ error: "Workspace not found" }, 404);
    const workspace = wsRows[0];
    if (workspace.status !== "idle") return c.json({ error: "Workspace is not idle" }, 409);
    const issueRows = await db.select({ projectId: issues.projectId, id: issues.id }).from(issues).where(eq(issues.id, workspace.issueId)).limit(1);
    if (issueRows.length === 0) return c.json({ error: "Issue not found" }, 404);
    const { projectId, id: issueId } = issueRows[0];
    const prefRows = await db.select().from(preferences);
    const prefMap = new Map(prefRows.map((r) => [r.key, r.value]));
    const manualProfile = prefMap.get("claude_profile") || undefined;
    const agentCommand = isMockProfile(manualProfile) ? MOCK_AGENT_COMMAND : (prefMap.get("agent_command") || undefined);
    const claudeProfile = isMockProfile(manualProfile) ? undefined : manualProfile;
    const provider = parseProviderPref(prefMap);
    const effectiveProfileName = getEffectiveProfile(prefMap, provider, claudeProfile);
    const manualProfileSelection = effectiveProfileName ? { provider, name: effectiveProfileName } : undefined;
    const reviewArgs = buildReviewArgs(prefMap, provider);
    const autoFix = prefMap.get("review_auto_fix") !== "false";
    const projectRows = await db.select({ defaultBranch: projects.defaultBranch }).from(projects).where(eq(projects.id, projectId)).limit(1);
    const defaultBranch = projectRows.length > 0 ? projectRows[0].defaultBranch : null;
    let diffRef = workspace.baseBranch || defaultBranch;
    let manualConflictingFiles: string[] | undefined;
    let manualUncommittedChanges: string[] | undefined;
    if (!workspace.isDirect && workspace.workingDir) {
      const baseBranch = workspace.baseBranch || defaultBranch;
      if (!baseBranch) return c.json({ error: "No default branch configured for this project. Set a default branch in project settings before reviewing." }, 400);
      const prep = await gitService.prepareForReview(workspace.workingDir, baseBranch);
      if (!prep.success) {
        manualConflictingFiles = prep.conflictingFiles;
        manualUncommittedChanges = prep.uncommittedChanges;
        console.warn(`[workflow] rebase failed for manual review ${workspaceId}: ${prep.error}`);
      }
      diffRef = prep.diffRef;
    }
    const manualSkillName = thoroughReview ? "code-review-thorough" : "code-review";
    const verifyAgent = prefMap.get("after_merge_verify_agent") || "none";
    const { prompt: reviewPromptText, model: reviewModel } = await buildReviewPrompt(workspace.branch, diffRef, issueId, autoFix, projectId, manualConflictingFiles, manualUncommittedChanges, workspaceId, manualSkillName, verifyAgent);
    const reviewArgsWithModel = reviewModel && provider === "claude" ? `${reviewArgs ?? ""} --model ${reviewModel}`.trim() : reviewArgs;
    const now = new Date().toISOString();
    await db.update(workspaces).set({ status: "reviewing", updatedAt: now }).where(eq(workspaces.id, workspaceId));
    boardEvents.broadcast(projectId, "issue_updated");
    const reviewExtraEnv: Record<string, string> = { KANBAN_SESSION_TYPE: "review", KANBAN_AFTER_MERGE_VERIFY: verifyAgent };
    const reviewSessionId = await sessionManager.startSession({ workspaceId, prompt: reviewPromptText, agentCommand, agentArgs: reviewArgsWithModel, claudeProfile, profile: manualProfileSelection, provider: toExecutorProvider(provider), triggerType: "review", extraEnv: reviewExtraEnv });
    reviewSessionIds.add(reviewSessionId);
    console.log(`[workflow] manual review session ${reviewSessionId} for workspace ${workspaceId}`);
    return c.json({ sessionId: reviewSessionId });
  });

  app.get("/ws/sessions/:sessionId", sessionManager.wsRoute());
  app.get("/ws/board/:projectId", boardEvents.wsRoute());
  app.route("/api", createRoutes(db, () => sessionManager, { boardEvents, fixAndMergeSessionIds }));
  app.route("/api/sessions", createSessionsRoute(db));

  const clientDir = resolve(__dirname, "../client");
  if (existsSync(resolve(clientDir, "index.html"))) {
    app.use("/*", serveStatic({ root: clientDir }));
    app.get("*", serveStatic({ root: clientDir, path: "index.html" }));
  }
}
