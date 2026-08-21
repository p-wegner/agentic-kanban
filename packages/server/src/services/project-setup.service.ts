import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveVerifyCommand } from "@agentic-kanban/shared/lib/verify-command";
import type { Database } from "../db/index.js";
import { invokeClaudePrompt } from "./claude-cli.service.js";
import { getProjectById } from "../repositories/project.repository.js";
import { detectProjectMarkers } from "./stack-markers.js";
import { detectStackProfile } from "./stack-detector.service.js";

// Re-exported so existing importers keep working; it LIVES in `stack-markers.ts` now
// (#521), which is what lets this module call the detector.
//
// `isUvProject` used to be re-exported here too and had ZERO consumers by this path —
// its one caller imports it from `stack-markers.js` directly (#695). A compat shim with
// no importers is not a stable import path, it is just a second name for the same
// function, so it is gone rather than documented.
export { detectProjectMarkers };

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
 * Verify (merge-gate) command for a project with no persisted stack profile yet (#521).
 *
 * This was a second per-marker table beside `detectStackProfile`'s — its own node
 * package-manager cascade (no bun), its own gradle branch (hardcoded `./gradlew`, which
 * cmd.exe cannot exec, and no Kotlin-multiplatform `allTests`), its own python branch
 * (no poetry/pipenv `run` prefix). So a project registered before its profile existed
 * got a DIFFERENT gate command than the same project registered after, and the UI's
 * "generate verify script" button could disagree with what registration wrote.
 *
 * The detector is pure and synchronous and already decides all of this, and
 * `deriveVerifyCommand` turns its profile into the canonical, exit-honest command (#124)
 * — the same one the builder is told to run. So the fallback is that pair, and the
 * ladder below is only what the detector does not model yet.
 *
 * `detected` is passed through rather than re-read so a caller that already scanned the
 * directory (and the tests) keeps deciding from the same marker set.
 */
export function deriveVerifyScript(repoPath: string, detected: string[]): string {
  const canonical = deriveVerifyCommand(detectStackProfile(repoPath, detected));
  if (canonical) return canonical;

  const detectedSet = new Set(detected);
  // Ecosystems the detector has no profile branch for. Keep them here until it grows one.
  if (detectedSet.has("Makefile")) {
    try {
      const makefile = readFileSync(join(repoPath, "Makefile"), "utf8");
      if (/^test:/m.test(makefile)) return "make test";
    } catch {
      // fall through
    }
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
