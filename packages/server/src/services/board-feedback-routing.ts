/**
 * Decide where a builder should report a flaw it finds in the BOARD ITSELF (as opposed to
 * in the project it is building).
 *
 * The answer depends on how the board is DEPLOYED, which is why it is computed here rather
 * than written into a doc:
 *
 *  - **git clone (development)** — the board's repo is normally registered as a project, so
 *    there is a real backlog the operator watches. Route: file a ticket against THAT project.
 *  - **`npx agentic-kanban` / global npm install** — the board's code is an immutable package
 *    under `node_modules`/the npx cache. Nobody develops it here.
 *  - **`docker run`** — the code lives in an image; edits die with the container.
 *
 * For the last two there is no board project to file into and nothing to patch, so a local
 * ticket would be written into a project backlog where nobody looks for board bugs. Those
 * route to GitHub instead.
 *
 * The misfiling this prevents is real: `create_issue` defaults to the board's ACTIVE project,
 * which is usually neither the project being built nor the board's own, so two board bugs
 * were once filed into a fixture project and sat there unactionable until moved by hand.
 * See CLAUDE.md "Board Feedback Conventions".
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { BoardFeedbackRouting } from "@agentic-kanban/shared/lib/ticket-context";
import { getAllProjects } from "../repositories/project.repository.js";
import type { Database } from "../db/index.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

/** This file lives at packages/server/src/services/ — four levels below the repo root. */
export const BOARD_REPO_ROOT = resolve(__dirname, "../../../../");

/** Where board bugs go when this machine has no board backlog. Overridable for forks. */
export const BOARD_ISSUES_URL =
  process.env.KANBAN_ISSUES_URL || "https://github.com/p-wegner/agentic-kanban/issues";

export type BoardDeployment = "source-checkout" | "packaged" | "container";

/**
 * Compare two repo paths the way the filesystem does rather than the way strings do.
 * Registration stores whatever path the user typed, so separators and drive-letter case
 * routinely differ from a `resolve()`d one on Windows — an exact string match misses.
 */
export function isSameRepoPath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const norm = (p: string) => resolve(p).replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Classify how this board is running.
 *
 * Container detection mirrors `service-stack-preflight.ts`: the board image sets
 * `IS_SANDBOX=1`, and `/.dockerenv` is Docker's own in-container marker. Container is
 * checked FIRST because a containerized board also ships its source tree — the tree
 * being present says nothing about it being editable-and-kept.
 */
export function detectBoardDeployment(
  boardRepoRoot: string = BOARD_REPO_ROOT,
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (p: string) => boolean = existsSync,
): BoardDeployment {
  if (env.IS_SANDBOX === "1" || fileExists("/.dockerenv")) return "container";
  // Installed as a dependency or run from the npx cache — read-only either way.
  const normalized = boardRepoRoot.replace(/\\/g, "/");
  if (normalized.includes("/node_modules/") || /\/[._]npx\//.test(normalized)) return "packaged";
  // A source checkout keeps its git dir; a published package never does.
  return fileExists(resolve(boardRepoRoot, ".git")) ? "source-checkout" : "packaged";
}

/**
 * Resolve the routing for this deployment, or null when there is nothing useful to say.
 *
 * `currentProjectId` is the project being provisioned, so a builder working IN the board's
 * own repo is told "file it here" rather than "file it over there".
 */
export async function resolveBoardFeedbackRouting(
  currentProjectId: string | null,
  database: Database,
  opts: { boardRepoRoot?: string; deployment?: BoardDeployment; issuesUrl?: string } = {},
): Promise<BoardFeedbackRouting | null> {
  const boardRepoRoot = opts.boardRepoRoot ?? BOARD_REPO_ROOT;
  const deployment = opts.deployment ?? detectBoardDeployment(boardRepoRoot);
  const issuesUrl = opts.issuesUrl ?? BOARD_ISSUES_URL;

  // A registered board project wins regardless of deployment: if the operator went to the
  // trouble of tracking the board on the board, that backlog is where they look. (It also
  // covers the case of a container/package driving a bind-mounted board checkout.)
  const projects = await getAllProjects(database);
  const self = projects.find((p) => isSameRepoPath(p.repoPath, boardRepoRoot));
  if (self) {
    return {
      kind: "file-ticket",
      projectId: self.id,
      projectName: self.name,
      isCurrentProject: self.id === currentProjectId,
    };
  }
  return { kind: "gh-issue", issuesUrl, deployment };
}
