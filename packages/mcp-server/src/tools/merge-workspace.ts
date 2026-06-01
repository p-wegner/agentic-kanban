import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { eq } from "drizzle-orm";
import * as gitService from "../git-service.js";
import { notifyBoard } from "../notify.js";
import { requireEntity } from "../db-utils.js";
import { applyOpenSpecDeltas, OPENSPEC_CHANGES_DIR, OPENSPEC_SPECS_DIR, validateOpenSpecChange } from "@agentic-kanban/shared/lib/openspec";
import { randomUUID } from "node:crypto";

async function recordMergeAttempt(args: {
  issueId: string;
  workspaceId: string;
  branch: string;
  eventType: "merged" | "direct-closed" | "conflict";
  body: string;
  payload?: Record<string, unknown>;
}) {
  const now = new Date().toISOString();
  await db.insert(schema.issueComments).values({
    id: randomUUID(),
    issueId: args.issueId,
    workspaceId: args.workspaceId,
    kind: "merge-attempt",
    author: "system",
    body: args.body,
    payload: JSON.stringify({
      eventType: args.eventType,
      workspaceId: args.workspaceId,
      branch: args.branch,
      ...args.payload,
    }),
    createdAt: now,
  }).catch((err) => {
    console.warn("[merge-workspace] failed to record merge timeline event:", err instanceof Error ? err.message : String(err));
  });
}

export function registerMergeWorkspace(server: McpServer) {
  server.tool(
    "merge_workspace",
    "Merge a workspace branch into the project's default branch, close the workspace, and auto-transition the issue to Done",
    {
      workspaceId: z.string().describe("The workspace ID to merge"),
    },
    async ({ workspaceId }) => {
      const wsRows = await db.select().from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId))
        .limit(1);
      const r0 = requireEntity(wsRows, workspaceId, "Workspace");
      if (!r0.ok) return r0.error;

      const workspace = r0.value;

      // Resolve project info
      const issueRows = await db.select({ projectId: schema.issues.projectId })
        .from(schema.issues)
        .where(eq(schema.issues.id, workspace.issueId))
        .limit(1);
      const r1 = requireEntity(issueRows, workspace.issueId, "Issue");
      if (!r1.ok) return r1.error;
      const projectId = r1.value.projectId;

      const projectRows = await db.select({
        repoPath: schema.projects.repoPath,
        defaultBranch: schema.projects.defaultBranch,
      }).from(schema.projects)
        .where(eq(schema.projects.id, projectId))
        .limit(1);
      if (projectRows.length === 0 || !projectRows[0].repoPath) {
        return { content: [{ type: "text" as const, text: "Project has no repo path configured" }] };
      }

      const { repoPath } = projectRows[0];

      try {
        // Direct workspace: just close, no merge
        if (workspace.isDirect) {
          const now = new Date().toISOString();
          await db.update(schema.workspaces)
            .set({ status: "closed", updatedAt: now })
            .where(eq(schema.workspaces.id, workspaceId));

          await autoTransitionDone(projectId, workspace.issueId, now);
          await recordMergeAttempt({
            issueId: workspace.issueId,
            workspaceId,
            branch: workspace.branch,
            eventType: "direct-closed",
            body: `Direct workspace ${workspaceId} was closed without a branch merge.`,
            payload: { closedAt: now },
          });
          notifyBoard(projectId, "mcp_merge_workspace");

          return {
            content: [{ type: "text" as const, text: JSON.stringify({ id: workspaceId, message: "Direct workspace closed (no merge needed)" }, null, 2) }],
          };
        }

        // Regular workspace: merge branch
        // Sync branch ref to worktree HEAD first — agent may have committed in detached HEAD
        if (workspace.workingDir) {
          await gitService.syncBranchToHead(workspace.workingDir, workspace.branch);
          const specValidation = await validateOpenSpecChange(workspace.workingDir);
          if (specValidation.deltas.length > 0) {
            const targetBranch = projectRows[0].defaultBranch || "main";
            const currentBranch = await gitService.getCurrentBranch(repoPath);
            if (currentBranch !== targetBranch) {
              return {
                content: [{
                  type: "text" as const,
                  text: `Cannot apply OpenSpec deltas: main checkout HEAD is on '${currentBranch}' but this workspace targets '${targetBranch}'. Check out '${targetBranch}' in the main checkout before merging OpenSpec changes.`,
                }],
              };
            }
            for (const warning of specValidation.warnings) {
              console.warn(`[merge-workspace] OpenSpec warning: ${warning}`);
            }
            if (workspace.baseCommitSha) {
              const domains = new Set(specValidation.deltas.map((delta) => delta.domain));
              const baseSpecChanges = await gitService.getChangedFilesBetween(
                repoPath,
                workspace.baseCommitSha,
                projectRows[0].defaultBranch || "main",
              );
              for (const domain of domains) {
                if (baseSpecChanges.includes(`openspec/specs/${domain}/spec.md`)) {
                  console.warn(
                    `[merge-workspace] OpenSpec warning: '${domain}' changed on ${projectRows[0].defaultBranch || "main"} since this workspace branched; review the living spec merge carefully.`,
                  );
                }
              }
            }
            if (!specValidation.valid) {
              return {
                content: [{ type: "text" as const, text: `OpenSpec change is invalid: ${specValidation.errors.join("; ")}` }],
              };
            }
          }
        }

        let preMergeHead = "";
        try { preMergeHead = await gitService.revParse(repoPath, "HEAD"); } catch { /* tolerate */ }
        const targetBranch = projectRows[0].defaultBranch || "main";
        let mergeOutput = await gitService.mergeBranch(repoPath, workspace.branch, targetBranch);
        let mergeCommitSha = "";
        try { mergeCommitSha = await gitService.revParse(repoPath, "HEAD"); } catch { /* tolerate */ }

        const changedFiles = preMergeHead
          ? await gitService.getChangedFilesBetween(repoPath, preMergeHead, "HEAD")
          : [];
        const specChangeIds = [...new Set(changedFiles
          .map((file) => file.match(/^openspec\/changes\/([^/]+)\/specs\/[^/]+\/spec\.md$/)?.[1])
          .filter((id): id is string => !!id))];
        let appliedCount = 0;
        for (const changeId of specChangeIds) {
          const specResult = await applyOpenSpecDeltas(repoPath, changeId, { removeAppliedDeltas: true });
          if (!specResult.valid) {
            throw new Error(`OpenSpec change '${changeId}' is invalid: ${specResult.errors.join("; ")}`);
          }
          appliedCount += specResult.applied.length;
          for (const warning of specResult.warnings) {
            console.warn(`[merge-workspace] OpenSpec warning: ${warning}`);
          }
        }
        if (appliedCount > 0) {
          const committed = await gitService.commitPaths(
            repoPath,
            [OPENSPEC_SPECS_DIR, OPENSPEC_CHANGES_DIR],
            `Update living OpenSpec specs for ${workspace.branch}`,
          );
          mergeOutput += `\nOpenSpec: applied ${appliedCount} domain delta(s)${committed ? " and committed living specs" : ""}.`;
        }

        // Cleanup worktree
        if (workspace.workingDir) {
          try { await gitService.removeWorktree(repoPath, workspace.workingDir); } catch {}
        }

        const now = new Date().toISOString();
        await db.update(schema.workspaces)
          .set({ status: "closed", workingDir: null, updatedAt: now, closedAt: now, mergedAt: now })
          .where(eq(schema.workspaces.id, workspaceId));

        await autoTransitionDone(projectId, workspace.issueId, now);
        await recordMergeAttempt({
          issueId: workspace.issueId,
          workspaceId,
          branch: workspace.branch,
          eventType: "merged",
          body: `Merged ${workspace.branch} into ${targetBranch}${mergeCommitSha ? ` at ${mergeCommitSha}` : ""}.`,
          payload: { targetBranch, commitSha: mergeCommitSha || null, mergedAt: now, mergeOutput },
        });
        notifyBoard(projectId, "mcp_merge_workspace");

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ id: workspaceId, mergeOutput }, null, 2) }],
        };
      } catch (err) {
        await recordMergeAttempt({
          issueId: workspace.issueId,
          workspaceId,
          branch: workspace.branch,
          eventType: "conflict",
          body: `Merge failed for ${workspace.branch}: ${err instanceof Error ? err.message : String(err)}`,
          payload: { error: err instanceof Error ? err.message : String(err) },
        });
        return {
          content: [{ type: "text" as const, text: `Merge failed: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );
}

async function autoTransitionDone(projectId: string, issueId: string, now: string) {
  try {
    const statuses = await db.select().from(schema.projectStatuses)
      .where(eq(schema.projectStatuses.projectId, projectId));
    const targetStatus = statuses.find(s => s.name === "Done");
    if (targetStatus) {
      await db.update(schema.issues)
        .set({ statusId: targetStatus.id, updatedAt: now })
        .where(eq(schema.issues.id, issueId));
    }
  } catch (err) {
    console.error("[merge-workspace] Failed to auto-transition issue:", err);
  }
}
