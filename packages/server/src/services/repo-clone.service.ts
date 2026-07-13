import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { DATA_DIR } from "../db/data-dir.js";

const CLONE_TIMEOUT_MS = 300_000;

/**
 * Where clone-from-URL registrations land: KANBAN_REPOS_DIR, else <data dir>/repos.
 * In the Docker image this is /data/repos (inside the persistent volume).
 */
export function getReposRoot(): string {
  return process.env.KANBAN_REPOS_DIR || join(DATA_DIR, "repos");
}

/** Derive a filesystem-safe directory name from a git URL (basename minus .git). */
export function repoDirNameFromUrl(cloneUrl: string): string {
  const tail = basename(cloneUrl.replace(/\/+$/, "")).replace(/\.git$/i, "");
  const sanitized = tail.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^[.-]+/, "");
  if (!sanitized) throw new Error(`Cannot derive a repository name from URL "${cloneUrl}"`);
  return sanitized;
}

/**
 * Clone `cloneUrl` into the repos root and return the checkout path.
 * Credentials are ambient only (SSH key, token-in-URL, git credential store);
 * GIT_TERMINAL_PROMPT=0 makes a missing credential fail fast instead of hanging.
 */
export async function cloneRepo(cloneUrl: string, opts: { name?: string } = {}): Promise<string> {
  const dirName = opts.name ? opts.name.replace(/[^a-zA-Z0-9._-]/g, "-") : repoDirNameFromUrl(cloneUrl);
  const root = getReposRoot();
  const target = resolve(root, dirName);
  if (!target.startsWith(resolve(root))) {
    throw new Error(`Refusing to clone outside the repos root: ${target}`);
  }
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new Error(`Target directory already exists and is not empty: ${target}`);
  }
  mkdirSync(root, { recursive: true });
  await gitExecOrThrow(["clone", cloneUrl, target], {
    timeout: CLONE_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return target;
}
