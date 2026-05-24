import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db, schema } from "../db.js";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as gitService from "../git-service.js";
import { notifyBoard } from "../notify.js";
import { runSetupScript } from "../setup-script.js";
import { writeAgentSkillFile } from "@agentic-kanban/shared/lib/agent-skill-files";

export function registerStartWorkspace(server: McpServer) {
  server.tool(
    "start_workspace",
    "Create a workspace for an issue: creates a git worktree and returns workspace info",
    {
      issueId: z.string().describe("The issue ID to create a workspace for"),
      repoPath: z.string().optional().describe("Absolute path to the git repository (auto-detected from project if omitted)"),
      branch: z.string().optional().describe("Branch name (defaults to 'workspace/{issueId-short}'). Not needed when isDirect is true."),
      baseBranch: z.string().optional().describe("Base branch to create from (defaults to project's defaultBranch)"),
      isDirect: z.boolean().optional().describe("Work directly on the main checkout instead of creating a worktree"),
      skillId: z.string().optional().describe("Agent skill ID to apply — the skill will be written as a SKILL.md file in the worktree for the agent to discover and invoke on demand"),
      planMode: z.boolean().optional().describe("If true, agent plans but does not implement. Restricts to read-only exploration and plan output."),
      skipSetup: z.boolean().optional().describe("If true, skip running the project's setup script for this workspace"),
    },
    async ({ issueId, repoPath, branch, baseBranch, isDirect, skillId, planMode, skipSetup }) => {
      // Look up the issue
      const issues = await db.select().from(schema.issues).where(eq(schema.issues.id, issueId)).limit(1);
      if (issues.length === 0) {
        return { content: [{ type: "text" as const, text: `Issue ${issueId} not found` }] };
      }

      // Resolve repoPath and defaultBranch from issue → project chain if not provided
      let resolvedRepoPath = repoPath;
      let resolvedBaseBranch = baseBranch;
      const issue = issues[0];
      const projectRows = await db
        .select({ repoPath: schema.projects.repoPath, defaultBranch: schema.projects.defaultBranch, setupScript: schema.projects.setupScript, setupEnabled: schema.projects.setupEnabled })
        .from(schema.projects)
        .where(eq(schema.projects.id, issue.projectId))
        .limit(1);

      if (projectRows.length === 0 || !projectRows[0].repoPath) {
        return { content: [{ type: "text" as const, text: `Project has no repo path configured. Provide repoPath explicitly.` }] };
      }

      if (!resolvedRepoPath) {
        resolvedRepoPath = projectRows[0].repoPath;
      }
      if (!resolvedBaseBranch) {
        resolvedBaseBranch = projectRows[0].defaultBranch;
      }

      const branchName = isDirect ? await gitService.getCurrentBranch(resolvedRepoPath) : (branch || `workspace/${issueId.slice(0, 8)}`);
      const id = randomUUID();
      const now = new Date().toISOString();

      try {
        let worktreePath: string;
        if (isDirect) {
          worktreePath = resolvedRepoPath;
        } else {
          worktreePath = await gitService.createWorktree(resolvedRepoPath, branchName, resolvedBaseBranch);
        }

        // Run setup script if configured and enabled
        const setupScript = projectRows[0].setupScript;
        const setupEnabled = projectRows[0].setupEnabled ?? true;
        if (setupScript && setupEnabled && !skipSetup) {
          try {
            const result = await runSetupScript(worktreePath, setupScript);
            if (result.exitCode === 0) {
              console.log(`[mcp] setup complete: workspaceId=${id}`);
            } else {
              console.warn(`[mcp] setup failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
            }
          } catch (err) {
            console.warn(`[mcp] setup error: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // Write skill as SKILL.md for progressive disclosure (agent invokes on demand)
        if (skillId && worktreePath) {
          const skillRows = await db.select().from(schema.agentSkills).where(eq(schema.agentSkills.id, skillId)).limit(1);
          if (skillRows.length > 0) {
            const skill = skillRows[0];
            await writeAgentSkillFile(worktreePath, skill);
          }
        }

        // Read agent settings to store on workspace
        const prefRows = await db.select().from(schema.preferences);
        const prefMap = new Map(prefRows.map(r => [r.key, r.value]));
        const provider = (prefMap.get("provider") || "claude") as string;
        const profileName = provider === "codex"
          ? (prefMap.get("codex_profile") || prefMap.get("claude_profile") || null)
          : (prefMap.get("claude_profile") || null);
        const agentCommand = prefMap.get("agent_command") || null;

        await db.insert(schema.workspaces).values({
          id,
          issueId,
          branch: branchName,
          workingDir: worktreePath,
          baseBranch: isDirect ? null : resolvedBaseBranch,
          isDirect: isDirect ?? false,
          planMode: planMode ?? false,
          skillId: skillId ?? null,
          status: "active",
          claudeProfile: profileName,
          agentCommand,
          provider,
          createdAt: now,
          updatedAt: now,
        });

        notifyBoard(issues[0].projectId, "mcp_start_workspace");

        const result = {
          id,
          issueId,
          branch: branchName,
          workingDir: worktreePath,
          isDirect: isDirect ?? false,
          status: "active",
          message: isDirect
            ? `Direct workspace created on branch '${branchName}'. Working directory: ${worktreePath}`
            : `Workspace created. Working directory: ${worktreePath}`,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to create workspace: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );
}
