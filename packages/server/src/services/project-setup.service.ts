import { readdirSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "../db/index.js";
import { invokeClaudePrompt } from "./claude-cli.service.js";
import { getProjectById } from "../repositories/project.repository.js";

const PROJECT_MARKER_FILES = [
  "package.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock",
  "Cargo.toml", "go.mod", "requirements.txt", "Pipfile", "pyproject.toml", "uv.lock",
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
  const project = await getProjectById(projectId, database);
  if (!project) {
    throw Object.assign(new Error("Project not found"), { statusCode: 404 });
  }

  const { repoPath, repoName } = project;
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
  const project = await getProjectById(projectId, database);
  if (!project) {
    throw Object.assign(new Error("Project not found"), { statusCode: 404 });
  }

  const { repoPath, repoName, setupScript } = project;
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

/**
 * Is this Python repo managed by `uv`? (#120)
 *
 * uv installs into a project-local `.venv`, so pytest is NOT importable from the global
 * interpreter — a bare `python -m pytest` merge gate fails with "No module named pytest"
 * and blocks every merge. Detected from the `uv.lock` lockfile or a `[tool.uv]` section
 * in `pyproject.toml`; everything for a uv project must be prefixed with `uv run`.
 *
 * Lives here (not stack-detector) because stack-detector imports THIS module — putting it
 * the other way round would make the cycle.
 */
export function isUvProject(repoPath: string, markers: Set<string> | string[]): boolean {
  const set = markers instanceof Set ? markers : new Set(markers);
  if (set.has("uv.lock")) return true;
  if (!set.has("pyproject.toml")) return false;
  try {
    return /^\s*\[tool\.uv[.\]]/m.test(readFileSync(join(repoPath, "pyproject.toml"), "utf8"));
  } catch {
    return false;
  }
}

/** Rule-based heuristic: derive a verify command from detected marker files. */
export function deriveVerifyScript(repoPath: string, detected: string[]): string {
  const detectedSet = new Set(detected);

  if (detectedSet.has("package.json")) {
    try {
      const pkgRaw = readFileSync(join(repoPath, "package.json"), "utf8");
      const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
      const scripts = pkg.scripts ?? {};
      const hasTest = "test" in scripts;
      const hasBuild = "build" in scripts;
      const hasBuildTs = "build:ts" in scripts;
      const pm = detectedSet.has("pnpm-lock.yaml") ? "pnpm" : detectedSet.has("yarn.lock") ? "yarn" : "npm";
      const parts: string[] = [];
      if (hasTest) parts.push(`${pm} test`);
      if (hasBuild) parts.push(`${pm} run build`);
      else if (hasBuildTs) parts.push(`${pm} run build:ts`);
      if (parts.length > 0) return parts.join(" && ");
    } catch {
      // fall through to AI
    }
  }

  if (detectedSet.has("Cargo.toml")) return "cargo test";
  if (detectedSet.has("go.mod")) return "go test ./...";
  if (detectedSet.has("pom.xml")) return "mvn test";
  if (detectedSet.has("build.gradle") || detectedSet.has("build.gradle.kts")) return "./gradlew test";
  if (detectedSet.has("Makefile")) {
    try {
      const makefile = readFileSync(join(repoPath, "Makefile"), "utf8");
      if (/^test:/m.test(makefile)) return "make test";
    } catch {
      // fall through
    }
  }
  if (detectedSet.has("Pipfile") || detectedSet.has("pyproject.toml") || detectedSet.has("requirements.txt")) {
    return isUvProject(repoPath, detectedSet) ? "uv run pytest" : "python -m pytest";
  }
  if (detectedSet.has("Gemfile")) return "bundle exec rake test";
  if (detectedSet.has("mix.exs")) return "mix test";

  return "";
}

export async function generateVerifyScript(projectId: string, database: Database): Promise<string> {
  const project = await getProjectById(projectId, database);
  if (!project) {
    throw Object.assign(new Error("Project not found"), { statusCode: 404 });
  }

  const { repoPath, repoName } = project;
  const detected = detectProjectMarkers(repoPath);

  const rule = deriveVerifyScript(repoPath, detected);
  if (rule) return rule;

  const prompt = `You are analyzing a software project to determine the correct verify/test command(s) to run to confirm that the code is correct and all tests pass.
Based on the files detected in the project root, suggest the appropriate verify command(s) for the project "${repoName}".

IMPORTANT: Respond ONLY with the raw shell command(s) to run. No explanation, no markdown, no code fences.
If multiple commands are needed, chain them with &&.
Use platform-neutral syntax (e.g., "pnpm test" not "npm test", prefer the package manager indicated by lock files).
Prefer commands that run fast. Favor test commands over build-only commands when available.
If no verify command can be determined, respond with an empty string.

Detected files: ${detected.length > 0 ? detected.join(", ") : "none"}`;

  return (await invokeClaudePrompt(prompt, { timeout: 30000, database })).trim();
}
