import { readdirSync } from "node:fs";
import { projects } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { invokeClaudePrompt } from "./claude-cli.service.js";

const PROJECT_MARKER_FILES = [
  "package.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock",
  "Cargo.toml", "go.mod", "requirements.txt", "Pipfile", "pyproject.toml",
  "pom.xml", "build.gradle", "build.gradle.kts", "Gemfile", "mix.exs",
  "Makefile", "justfile", "Taskfile.yml",
];

export function detectProjectMarkers(repoPath: string): string[] {
  try {
    const files = readdirSync(repoPath);
    return files.filter(f => PROJECT_MARKER_FILES.includes(f));
  } catch {
    return [];
  }
}

export async function generateSetupScript(projectId: string, database: Database): Promise<string> {
  const projectRows = await database
    .select({ repoPath: projects.repoPath, repoName: projects.repoName })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (projectRows.length === 0) {
    throw Object.assign(new Error("Project not found"), { statusCode: 404 });
  }

  const { repoPath, repoName } = projectRows[0];
  const detected = detectProjectMarkers(repoPath);

  const prompt = `You are analyzing a software project to determine the correct setup command(s) to run after cloning the repository into a fresh git worktree.
Based on the files detected in the project root, suggest the appropriate setup command(s) for the project "${repoName}".

IMPORTANT: Respond ONLY with the raw shell command(s) to run. No explanation, no markdown, no code fences.
If multiple commands are needed, chain them with &&.
Use platform-neutral syntax (e.g., "pnpm install" not "npm i", prefer the package manager indicated by lock files).
If no setup is needed, respond with an empty string.

Detected files: ${detected.length > 0 ? detected.join(", ") : "none"}`;

  return (await invokeClaudePrompt(prompt, { timeout: 30000, database })).trim();
}

export async function generateTeardownScript(projectId: string, database: Database): Promise<string> {
  const projectRows = await database
    .select({ repoPath: projects.repoPath, repoName: projects.repoName, setupScript: projects.setupScript })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (projectRows.length === 0) {
    throw Object.assign(new Error("Project not found"), { statusCode: 404 });
  }

  const { repoPath, repoName, setupScript } = projectRows[0];
  const detected = detectProjectMarkers(repoPath);

  const contextParts: string[] = [];
  if (detected.length > 0) contextParts.push(`Detected files: ${detected.join(", ")}`);
  if (setupScript) contextParts.push(`Current setup script: ${setupScript}`);

  const prompt = `You are analyzing a software project to determine the correct teardown/cleanup command(s) to run before removing a git worktree.
Based on the project context, suggest appropriate teardown command(s) for the project "${repoName}".

The teardown runs in the worktree directory on EVERY worktree-end path (merge, delete,
abandon) — before the worktree is removed. It should clean up resources THIS PROJECT
spins up that the app cannot clean up generically, for example:
- Containers / compose stacks (e.g. "docker compose -p ws-$KANBAN_ISSUE_NUMBER down -v")
- Background processes/servers on non-standard ports, watchers, daemons
- Named volumes, remote sandboxes, or external resources keyed to the workspace
- Large generated directories (e.g. node_modules, build artifacts) to free disk space

Note: the app ALREADY frees the worktree's own monorepo dev-server ports automatically,
so you do NOT need to kill those — focus on resources unique to this project.

These environment variables are available to your command(s):
- KANBAN_WORKTREE_DIR — absolute path of the worktree
- KANBAN_WORKTREE_BRANCH — the branch name
- KANBAN_ISSUE_NUMBER — the issue number (when the branch encodes one)
- KANBAN_WORKTREE_SERVER_PORT / KANBAN_WORKTREE_CLIENT_PORT — the app's dev ports for this worktree

IMPORTANT: Respond ONLY with the raw shell command(s) to run. No explanation, no markdown, no code fences.
If multiple commands are needed, chain them with &&.
Use || true for commands that may fail (e.g. "docker compose down || true").
If no teardown is needed, respond with an empty string.

${contextParts.join("\n")}`;

  return (await invokeClaudePrompt(prompt, { timeout: 30000, database })).trim();
}
