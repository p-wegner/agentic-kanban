import { execFile } from "node:child_process";
import { getBool } from "@agentic-kanban/shared/lib/settings-registry";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import type { Database } from "../db/index.js";
import type { SessionLauncher } from "./session.manager.js";
import { resolveAgentSettings, toExecutorProvider } from "./agent-settings.service.js";
import { PREF_LEARNING_STEP_BEFORE_MERGE } from "../constants/preference-keys.js";
import { getSessionStatus } from "../repositories/session.repository.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

const execFileAsync = promisify(execFile);
const moduleDir = dirname(fileURLToPath(import.meta.url));

export function resolveCanonicalLearningStepSkillPath(): string {
  const candidates = [
    resolve(process.cwd(), ".claude/skills/learning-step/SKILL.md"),
    resolve(moduleDir, "../../../../.claude/skills/learning-step/SKILL.md"),
    resolve(moduleDir, "../../../.claude/skills/learning-step/SKILL.md"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0];
}

export function buildLearningStepPrompt(beforeMerge = false): string {
  const canonicalSkillPath = resolveCanonicalLearningStepSkillPath();
  const timing = beforeMerge ? " before this workspace is merged" : "";
  return `/learning-step

Run the learning step skill to extract insights from recent session transcripts and update docs/hooks${timing}.

If this project does not expose a local learning-step slash command or skill, read and follow the canonical board skill at:
${canonicalSkillPath}`;
}

/**
 * If a merge changed files under packages/shared/src/**, rebuild the shared
 * package's dist/ so tsx-watch hot-reload doesn't crash on stale exports.
 */
export async function rebuildSharedIfChanged(
  repoPath: string,
  changedFiles: string[],
): Promise<void> {
  const sharedChanged = changedFiles.some((f) =>
    f.replace(/\\/g, "/").startsWith("packages/shared/src/"),
  );
  if (!sharedChanged) return;
  try {
    console.log("[merge-helpers] packages/shared/src/** changed — rebuilding shared/dist");
    await execFileAsync("pnpm", ["--filter", "@agentic-kanban/shared", "build"], {
      cwd: repoPath,
      timeout: 60_000,
      shell: process.platform === "win32",
      windowsHide: true,
    });
    console.log("[merge-helpers] shared/dist rebuild complete");
  } catch (err) {
    console.warn("[merge-helpers] shared/dist rebuild failed (non-fatal):", errorMessage(err));
  }
}

/** Returns conflicting file paths from an in-progress merge/rebase (git diff --name-only --diff-filter=U). */
export async function getConflictingFiles(workingDir: string): Promise<string[]> {
  const { stdout, error } = await gitExec(["diff", "--name-only", "--diff-filter=U"], { cwd: workingDir });
  if (error) return [];
  return stdout.trim().split("\n").filter(Boolean);
}

/**
 * The fix-and-merge prompt (#943).
 *
 * `kind` decides which body follows the error, and getting it wrong is expensive in both
 * directions. The original prompt was entirely about WORKING-TREE cleanliness — "stash, reset,
 * or commit" — which is correct advice for a dirty tree and actively misleading for a red verify
 * gate: the agent checks `git status`, finds it clean, confirms the branch fast-forwards, and
 * exits 0 having done nothing (measured on #935, a full ~10-minute cycle). A gate failure needs
 * the opposite instruction: the tree is fine, a test is red, go make it pass.
 */
export function buildFixAndMergePrompt(
  errorMessage: string,
  baseBranch: string,
  kind: "pre-merge-gate" | "merge" | "unknown" = "merge",
  verifyLogPath?: string | null,
): string {
  if (kind === "pre-merge-gate") return buildGateFailureFixPrompt(errorMessage, baseBranch, verifyLogPath);
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

/**
 * The prompt for a merge withheld by the PRE-MERGE GATE (#943) — a red verify run, not a dirty
 * tree. It names the failing output, points at the full log when one was written, and states the
 * one thing the working-tree prompt got backwards: a clean `git status` is EXPECTED here and is
 * not evidence that there is nothing to fix.
 */
function buildGateFailureFixPrompt(
  gateMessage: string,
  baseBranch: string,
  verifyLogPath?: string | null,
): string {
  const logLine = verifyLogPath
    ? `\nThe full verify run is at: ${verifyLogPath}\nRead it if the excerpt above is truncated — it holds the complete output.\n`
    : "";
  return `The merge of this workspace branch into ${baseBranch} was WITHHELD by the pre-merge verify gate.
This is NOT a merge conflict and NOT a dirty working tree — the branch is mergeable, but its
verification run is RED. Here is what the gate reported:

${gateMessage}
${logLine}
Your job is to make that verification pass on this branch.

Steps:
1. Read the failure above and identify the exact suite/test/check that failed.
2. Reproduce it locally — re-run ONLY that file first (e.g. the project's test runner against
   the named path), not the whole suite.
3. Fix the underlying defect in this branch's code. If the failing check is a ratchet/guard that
   your change legitimately moved, update the ratchet's recorded baseline as that guard's own
   documentation instructs — do not delete or weaken the guard.
4. Re-run the project's verify command to confirm it is green.
5. Commit the fix.

Important:
- A clean "git status" is EXPECTED and proves nothing here. Do not conclude there is nothing to
  fix because the tree is clean and the branch fast-forwards — the failure is in the test run.
- Do NOT attempt the merge yourself; the board re-runs the gate and merges once it is green.
- If after investigating you are confident the failure is unrelated to this branch (it also fails
  on ${baseBranch}), say so explicitly in your final message and name the evidence, rather than
  exiting silently with no commits.

Base branch: ${baseBranch}`;
}

export function buildConflictResolutionPrompt(
  conflictingFiles: string[],
  baseBranch: string,
  /** Pre-extracted conflict hunks (#128) — saves the reconciler a cold hunt through the tree. */
  conflictContext?: string | null,
): string {
  const contextBlock = conflictContext?.trim() ? `\n${conflictContext.trim()}\n` : "";
  return `Resolve the merge/rebase conflicts in this workspace.

Conflicting files:
${conflictingFiles.map(f => `- ${f}`).join("\n")}
${contextBlock}

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
  getSessionManager: () => SessionLauncher,
): Promise<void> {
  if (!getBool(prefMap, PREF_LEARNING_STEP_BEFORE_MERGE)) return;

  try {
    const learningPrompt = buildLearningStepPrompt(true);
    const { agentCommand: agentCmd, agentArgs, profile, provider } = resolveAgentSettings(prefMap);
    const sm = getSessionManager();
    const learningSessId = await sm.startSession({ workspaceId, prompt: learningPrompt, agentCommand: agentCmd, agentArgs, profile, provider: toExecutorProvider(provider), triggerType: "learning" });
    console.log(`[merge-helpers] learning step started: session=${learningSessId}`);

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        console.log("[merge-helpers] learning step timed out after 3m, proceeding with merge");
        resolve();
      }, 3 * 60 * 1000);
      const poll = setInterval(() => {
        void (async () => {
          const status = await getSessionStatus(learningSessId, database);
          if (status !== null && status !== "running") {
            clearInterval(poll);
            clearTimeout(timeout);
            console.log(`[merge-helpers] learning step finished: status=${status}`);
            resolve();
          }
        })();
      }, 5000);
    });
  } catch (err) {
    console.warn("[merge-helpers] learning step failed (non-fatal):", err);
  }
}
