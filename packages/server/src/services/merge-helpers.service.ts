import { sessions } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { execFile } from "node:child_process";
import type { Database } from "../db/index.js";
import type { SessionManager } from "./session.manager.js";
import { resolveAgentSettings, toExecutorProvider } from "./agent-settings.service.js";
import { PREF_LEARNING_STEP_BEFORE_MERGE } from "../constants/preference-keys.js";

/** Returns conflicting file paths from an in-progress merge/rebase (git diff --name-only --diff-filter=U). */
export async function getConflictingFiles(workingDir: string): Promise<string[]> {
  try {
    const output = await new Promise<string>((res, rej) => {
      execFile("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: workingDir }, (err, stdout) => {
        if (err) rej(err); else res(stdout.toString());
      });
    });
    return output.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export function buildFixAndMergePrompt(errorMessage: string, baseBranch: string): string {
  return `The merge of this workspace branch into ${baseBranch} failed with this error:

${errorMessage}

Fix the issue so the branch can be merged. Common causes:
- Uncommitted changes in the working tree (stash or commit them)
- Binary file conflicts (remove the problematic files from the branch if they are generated files like .db-shm, .db-wal, .db)
- Dirty working tree (reset uncommitted changes with "git checkout -- ." or "git stash")

Steps:
1. Run "git status" to see what is going on
2. Fix the issue (stash, reset, or commit as appropriate)
3. Do NOT attempt the merge yourself - just clean up the working tree so it is ready for merge
4. Commit any fixes if needed

Base branch: ${baseBranch}`;
}

export function buildConflictResolutionPrompt(conflictingFiles: string[], baseBranch: string): string {
  return `Resolve the merge/rebase conflicts in this workspace.

Conflicting files:
${conflictingFiles.map(f => `- ${f}`).join("\n")}

For each conflicting file:
1. Read the file and examine the conflict markers (<<<<<<<, =======, >>>>>>>)
2. Understand the intent of both changes
3. Resolve the conflict by keeping the correct code from both sides — prefer the feature branch changes unless the base branch change is clearly needed
4. Remove all conflict markers
5. Stage the resolved file with: git add <filename> (use the actual filename)

After resolving all conflicts:
- If this was a rebase: run "git rebase --continue"
- If this was a merge: run "git commit --no-edit"

Base branch: ${baseBranch}`;
}

/**
 * Runs the learning-step agent session and waits up to 3 minutes for it to complete.
 * No-op if PREF_LEARNING_STEP_BEFORE_MERGE is not "true".
 */
export async function runLearningStep(
  workspaceId: string,
  prefMap: Map<string, string>,
  database: Database,
  getSessionManager: () => SessionManager,
): Promise<void> {
  if (prefMap.get(PREF_LEARNING_STEP_BEFORE_MERGE) !== "true") return;

  try {
    const learningPrompt = `/learning-step\n\nRun the learning step skill to extract insights from recent session transcripts and update docs/hooks before this workspace is merged.`;
    const { agentCommand: agentCmd, agentArgs, claudeProfile, profile, provider } = resolveAgentSettings(prefMap);
    const sm = getSessionManager();
    const learningSessId = await sm.startSession({ workspaceId, prompt: learningPrompt, agentCommand: agentCmd, agentArgs, claudeProfile, profile, provider: toExecutorProvider(provider), triggerType: "learning" });
    console.log(`[merge-helpers] learning step started: session=${learningSessId}`);

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        console.log("[merge-helpers] learning step timed out after 3m, proceeding with merge");
        resolve();
      }, 3 * 60 * 1000);
      const poll = setInterval(async () => {
        const sessRows = await database.select({ status: sessions.status }).from(sessions).where(eq(sessions.id, learningSessId)).limit(1);
        if (sessRows.length > 0 && sessRows[0].status !== "running") {
          clearInterval(poll);
          clearTimeout(timeout);
          console.log(`[merge-helpers] learning step finished: status=${sessRows[0].status}`);
          resolve();
        }
      }, 5000);
    });
  } catch (err) {
    console.warn("[merge-helpers] learning step failed (non-fatal):", err);
  }
}
