import type { Command } from "commander";
import { randomUUID } from "node:crypto";
import { detectRepoInfo } from "../../services/git-info.service.js";
import { getCurrentBranch } from "../../services/git.service.js";
import { DEFAULT_STATUSES } from "../../repositories/issue.repository.js";
import { getProjectByRepoPath, insertProject } from "../../repositories/project.repository.js";
import { setPreference } from "../../repositories/preferences.repository.js";
import { runMigrations, logDefaultBranch } from "../shared.js";
import { getDefaultSkillId, ensureAgentGitignore, ensureStarterClaudeMd, ensureStarterAgentsMd, ensureHookScaffold, ensureVerifyGateRunner, commitProjectScaffoldArtifacts } from "../../services/project-scaffold.js";
import { detectStackProfile } from "../../services/stack-profile.service.js";

/** Fall back to the repo's checked-out branch when main/master isn't detected, so the project is never left undriveable (#772). */
async function resolveCliDefaultBranch(repoPath: string, detected: string | null): Promise<string | null> {
  if (detected) return detected;
  try {
    const current = (await getCurrentBranch(repoPath)).trim();
    if (current && current !== "HEAD") return current;
  } catch { /* no commits / git unavailable */ }
  return null;
}

export function registerRegisterCommand(program: Command) {
  program
    .command("register")
    .description("Register a git repo as a project.\n\nAuto-detects repo name, default branch, and remote URL from the git repo at <path>. Creates the default statuses (Backlog, Todo, In Progress, In Review, AI Reviewed, Done, Cancelled) and sets the project as the active project.\n\nIf the repo is already registered (same path), it skips without error.")
    .argument("[path]", "Path to the git repository")
    .option("-n, --name <name>", "Custom project name (defaults to repo directory name)")
    .option("--clone <url>", "Clone this git URL into the repos root (KANBAN_REPOS_DIR or <data dir>/repos) and register the clone")
    .addHelpText("after", `
Examples:
  $ agentic-kanban register .                 # register current directory
  $ agentic-kanban register /path/to/my-repo  # register a specific repo
  $ agentic-kanban register . --name "My App" # custom project name
  $ agentic-kanban register --clone https://github.com/user/repo.git
`)
    .action(async (path: string | undefined, options: { name?: string; clone?: string }) => {
      try {
        if (!path && !options.clone) {
          console.error("Error: provide a <path> or --clone <url>");
          process.exit(1);
        }
        if (path && options.clone) {
          console.error("Error: provide either <path> or --clone <url>, not both");
          process.exit(1);
        }
        await runMigrations();

        if (options.clone) {
          const { cloneRepo } = await import("../../services/repo-clone.service.js");
          path = await cloneRepo(options.clone, { name: options.name });
          console.log(`Cloned ${options.clone} to ${path}`);
        }

        const repoInfo = await detectRepoInfo(path!);
        const projectName = options.name || repoInfo.repoName;

        const existing = await getProjectByRepoPath(repoInfo.repoPath);
        if (existing) {
          console.log(`Project "${existing.name}" already registered at ${repoInfo.repoPath}`);
          process.exit(0);
        }

        const projectId = randomUUID();
        const defaultBranch = await resolveCliDefaultBranch(repoInfo.repoPath, repoInfo.defaultBranch);

        // insertProject also creates the canonical 7-status set (incl. Backlog at -1)
        // so auto-driven Backlog-pull works (#772).
        await insertProject(projectId, {
          name: projectName,
          repoPath: repoInfo.repoPath,
          repoName: repoInfo.repoName,
          defaultBranch,
          remoteUrl: repoInfo.remoteUrl,
          defaultSkillId: await getDefaultSkillId(),
        });

        await setPreference("activeProjectId", projectId);

        // Scaffold (clobber-safe): keep agent scratch out of history + drop a starter CLAUDE.md + hooks + verify-gate runner.
        // Per-stack build-output ignores (target/, __pycache__/, *.class, …) keep a non-Node toy project's
        // build artifacts from making main dirty and blocking auto-merge (#811).
        ensureAgentGitignore(repoInfo.repoPath, undefined, detectStackProfile(repoInfo.repoPath).stack);
        ensureStarterClaudeMd(repoInfo.repoPath);
        ensureStarterAgentsMd(repoInfo.repoPath);
        ensureHookScaffold(repoInfo.repoPath);
        ensureVerifyGateRunner(repoInfo.repoPath);
        await commitProjectScaffoldArtifacts(repoInfo.repoPath);

        console.log(`Registered project "${projectName}"`);
        console.log(`  Repo: ${repoInfo.repoPath}`);
        logDefaultBranch(defaultBranch);
        if (repoInfo.remoteUrl) {
          console.log(`  Remote: ${repoInfo.remoteUrl}`);
        }
        console.log(`  Statuses: ${DEFAULT_STATUSES.map((s) => s.name).join(", ")}`);
        console.log(`  Set as active project.`);
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
