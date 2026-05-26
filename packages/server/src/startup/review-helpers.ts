import { db } from "../db/index.js";
import { agentSkills } from "@agentic-kanban/shared/schema";
import { sql, desc } from "drizzle-orm";
import type { ProviderName } from "../services/agent-provider.js";
import { PREF_CODEX_PROFILE, PREF_COPILOT_PROFILE } from "../constants/preference-keys.js";

export const DEFAULT_MONITOR_NUDGE_PROMPT =
  "Please continue with the task. If you are waiting for input or unsure how to proceed, use your best judgment and keep moving forward. Check the issue description and any open questions, then take the next logical step.";

export const DEFAULT_REVIEW_PROMPT = `You are an AI code reviewer. Review the changes on branch '{{branch}}'.

First, run 'git diff --stat {{baseBranch}}' to see an overview of changed files.
Then review each file individually with 'git diff {{baseBranch}} -- <filepath>' — do NOT dump the entire diff at once.

Review for: correctness bugs, security vulnerabilities, logic errors, and missing error handling.
Classify each issue as CRITICAL (must fix — bugs, security, data loss), MAJOR (should fix — broken edge cases, poor error handling), or MINOR (nice to have — style, naming).

{{autoFixInstructions}}

Do NOT move the issue to 'AI Reviewed' yourself — the system handles that on merge.

Issue ID: {{issueId}}
Workspace ID: {{workspaceId}}`;

export function buildReviewArgs(prefMap: Map<string, string>, provider: ProviderName): string | undefined {
  // `--dangerously-skip-permissions` is Claude-only; other providers use native
  // permission flags and abort on Claude-specific arguments.
  const skipPerms = prefMap.get("skip_permissions") === "true" && provider === "claude";
  const baseArgs = prefMap.get("agent_args") || "";
  if (skipPerms) {
    return baseArgs ? baseArgs + " --dangerously-skip-permissions" : "--dangerously-skip-permissions";
  }
  return baseArgs || undefined;
}

export function parseProviderPref(prefMap: Map<string, string>): ProviderName {
  const provider = prefMap.get("provider");
  if (provider === "codex" || provider === "copilot") return provider;
  return "claude";
}

export function getEffectiveProfile(prefMap: Map<string, string>, provider: ProviderName, claudeProfile: string | undefined): string | undefined {
  if (provider === "codex") return prefMap.get(PREF_CODEX_PROFILE) || undefined;
  if (provider === "copilot") return prefMap.get(PREF_COPILOT_PROFILE) || undefined;
  return claudeProfile;
}

export async function buildReviewPrompt(
  branch: string,
  baseBranch: string | null,
  issueId: string,
  autoFix: boolean,
  projectId?: string,
  conflictingFiles?: string[],
  uncommittedChanges?: string[],
  workspaceId?: string,
  skillName = "code-review",
  verifyAgent?: string,
): Promise<{ prompt: string; model: string | null }> {
  let template: string | null = null;
  let skillModel: string | null = null;
  if (projectId) {
    const projectSkill = await db.select({ prompt: agentSkills.prompt, model: agentSkills.model }).from(agentSkills)
      .where(sql`${agentSkills.name} = ${skillName} AND (${agentSkills.projectId} = ${projectId} OR ${agentSkills.projectId} IS NULL)`)
      .orderBy(desc(agentSkills.projectId))
      .limit(1);
    template = projectSkill[0]?.prompt ?? null;
    skillModel = projectSkill[0]?.model ?? null;
  }
  if (!template) {
    const globalSkill = await db.select({ prompt: agentSkills.prompt, model: agentSkills.model }).from(agentSkills)
      .where(sql`${agentSkills.name} = ${skillName} AND ${agentSkills.projectId} IS NULL`)
      .limit(1);
    template = globalSkill[0]?.prompt ?? DEFAULT_REVIEW_PROMPT;
    skillModel = globalSkill[0]?.model ?? null;
  }

  const autoFixInstructions = autoFix
    ? `If you find CRITICAL or MAJOR issues:
1. Use the move_issue MCP tool to move issue ${issueId} to 'In Progress' (so the board shows the issue needs fixes)
2. Fix all critical and major issues directly in the code
3. Commit the fixes with a descriptive message
4. Exit normally (the system will handle merging)

If only MINOR issues or no issues:
1. Use the mark_ready_for_merge MCP tool with workspaceId={{workspaceId}} to signal the workspace is approved
2. Exit normally (the system will auto-merge)`
    : `If you find CRITICAL or MAJOR issues:
1. Use the move_issue MCP tool to move issue ${issueId} to 'In Progress'
2. Describe each issue clearly so the developer knows what to fix
3. Do NOT edit any files — report only

If only MINOR issues or no issues:
1. Use the mark_ready_for_merge MCP tool with workspaceId={{workspaceId}} to signal the workspace is approved
2. Exit normally (the system will auto-merge)`;

  // Strip "origin/" prefix so rebase instructions use the bare branch name.
  const localBaseBranch = (baseBranch ?? "HEAD").replace(/^origin\//, "");

  let conflictPreamble = "";
  if (uncommittedChanges && uncommittedChanges.length > 0) {
    conflictPreamble = `IMPORTANT: The worktree has uncommitted changes. You must commit or stash them before rebasing and reviewing.

Uncommitted files (git status --porcelain):
${uncommittedChanges.map(f => `  ${f}`).join("\n")}

Steps to resolve:
1. Review the changes: git diff (for unstaged), git diff --cached (for staged)
2. If the changes belong to this branch: git add -A && git commit -m "WIP: uncommitted changes"
3. Then rebase: git rebase origin/${localBaseBranch} (or git rebase ${localBaseBranch} if no remote)
4. Once the working tree is clean and rebased, proceed with the code review below.

---

`;
  } else if (conflictingFiles && conflictingFiles.length > 0) {
    conflictPreamble = `IMPORTANT: Auto-rebase onto the base branch failed due to conflicts. The rebase has been aborted, so the worktree is clean. You must resolve the conflicts and rebase manually before reviewing.

Conflicting files:
${conflictingFiles.map(f => `- ${f}`).join("\n")}

Steps to resolve:
1. Start a fresh rebase: git rebase origin/${localBaseBranch}
   (or use the local branch if no remote: git rebase ${localBaseBranch})
2. For each conflicting file, open it and resolve the conflict markers (<<<<<<<, =======, >>>>>>>)
3. After resolving each file: git add <resolved-file>
4. Continue: git rebase --continue (repeat for each conflicting commit)
5. Once the rebase completes, proceed with the code review below.

---

`;
  }

  const serverPort = process.env.KANBAN_SERVER_PORT || process.env.PORT || "3001";
  const clientPort = process.env.KANBAN_CLIENT_PORT || process.env.VITE_PORT || "5173";

  let prompt = conflictPreamble + template
    .replace(/\{\{branch}}/g, branch)
    .replace(/\{\{baseBranch}}/g, baseBranch ?? "HEAD")
    .replace(/\{\{issueId}}/g, issueId)
    .replace(/\{\{workspaceId}}/g, workspaceId ?? "")
    .replace(/\{\{serverPort}}/g, serverPort)
    .replace(/\{\{clientPort}}/g, clientPort)
    .replace(/\{\{autoFixInstructions}}/g, autoFixInstructions);

  if (verifyAgent === "reviewer") {
    prompt += `

## Post-Review: Merge + Visual Verification Required

This project uses \`visual_verification_mode=after_merge\` with \`after_merge_verify_agent=reviewer\`.
**You are responsible for the complete pipeline**: approve code → merge workspace → visual verify on master.

After completing your code review and fixing any CRITICAL/MAJOR issues:

1. **Merge the workspace** (instead of mark_ready_for_merge, call merge directly):
   \`\`\`
   curl -s -X POST http://localhost:${serverPort}/api/workspaces/${workspaceId ?? "{{workspaceId}}"}/merge
   \`\`\`

2. **After merge, visually verify** the UI changes on master:
   - Use the playwright-cli skill (/playwright-cli) or run playwright directly
   - Navigate to http://localhost:${clientPort}
   - Check the relevant UI sections for the changed files on branch '${branch}'
   - Take a screenshot to confirm the UI renders correctly

3. **Report** your verification result.

The stop hook will remind you if you try to exit before completing all three steps.`;
  }

  return { prompt, model: skillModel };
}

export async function buildMonitorNudgePrompt(projectId: string): Promise<string> {
  const skillRows = await db
    .select({ prompt: agentSkills.prompt })
    .from(agentSkills)
    .where(sql`
      ${agentSkills.name} = 'monitor-nudge'
      AND (${agentSkills.projectId} = ${projectId} OR ${agentSkills.projectId} IS NULL)
    `)
    .orderBy(sql`${agentSkills.projectId} IS NULL`)
    .limit(1);

  return skillRows[0]?.prompt?.trim() || DEFAULT_MONITOR_NUDGE_PROMPT;
}
