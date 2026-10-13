// What a worker actually runs (#1460): the files reachable from the worker CLI entry
// (the same import graph `worker-cli-isolation.test.ts` bounds) plus the packaging inputs.
// The board advertises the LAST COMMIT TOUCHING THESE FILES as the worker build id instead
// of its own HEAD, so a promote that changes only board code leaves every worker `in-sync`
// and nothing drains.

import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gitExec, gitExecSync } from "@agentic-kanban/shared/lib/git-exec";

/** Files outside the import graph that still change what a packed worker is. */
const PACKAGING_INPUTS = ["packages/server/package.json", "packages/shared/package.json", "pnpm-lock.yaml", "scripts/pack-worker.mjs"];

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[^;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

function resolveModule(fromFile: string, spec: string, repoRoot: string): string | null {
  let base: string;
  if (spec.startsWith(".")) {
    base = resolve(dirname(fromFile), spec);
  } else if (spec === "@agentic-kanban/shared") {
    base = resolve(repoRoot, "packages/shared/src/index");
  } else if (spec.startsWith("@agentic-kanban/shared/")) {
    base = resolve(repoRoot, "packages/shared/src", spec.slice("@agentic-kanban/shared/".length));
  } else {
    return null;
  }
  base = base.replace(/\.js$/, "");
  for (const candidate of [`${base}.ts`, resolve(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Repo-relative (forward-slash) files the worker bundle is made of; empty when there is no source tree. */
export function workerBundleFiles(repoRoot: string): string[] {
  const entry = resolve(repoRoot, "packages/server/src/worker/worker-cli.ts");
  if (!existsSync(entry)) return [];
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2];
      const local = spec ? resolveModule(file, spec, repoRoot) : null;
      if (local) queue.push(local);
    }
  }
  const files = [...seen].map((f) => relative(repoRoot, f).replace(/\\/g, "/"));
  for (const extra of PACKAGING_INPUTS) if (existsSync(resolve(repoRoot, extra))) files.push(extra);
  return files.sort();
}

/**
 * The last commit (full sha) touching the worker bundle, or null when there is no source
 * tree / git. Callers fall back to HEAD, i.e. the old "any board change is a new build".
 */
export async function resolveWorkerBundleCommit(repoRoot: string): Promise<string | null> {
  const files = workerBundleFiles(repoRoot);
  if (files.length === 0) return null;
  const result = await gitExec(["log", "-1", "--format=%H", "HEAD", "--", ...files], { cwd: repoRoot });
  const sha = result.stdout.trim().toLowerCase();
  return result.error || !/^[0-9a-f]{40}$/.test(sha) ? null : sha;
}

let cachedSync: { at: number; value: string | null } | undefined;
const SYNC_TTL_MS = 30_000;

/**
 * Sync, TTL-cached flavour for the places that only compare (placement explain, update-check,
 * the status console host row). Falls back to the board's HEAD when the bundle cannot be
 * resolved, which is the pre-#1460 behaviour. `nowMs` is injected for tests.
 */
export function resolveBoardWorkerBuild(
  startDir: string = dirname(fileURLToPath(import.meta.url)),
  fallback: () => string | null = () => null,
  nowMs: number = Date.now(),
): string | null {
  if (cachedSync && nowMs - cachedSync.at < SYNC_TTL_MS) return cachedSync.value;
  let value: string | null = null;
  try {
    const root = gitExecSync(["rev-parse", "--show-toplevel"], { cwd: startDir, timeout: 5000 }).trim();
    const files = workerBundleFiles(root);
    if (files.length > 0) {
      const sha = gitExecSync(["log", "-1", "--format=%H", "HEAD", "--", ...files], { cwd: root, timeout: 5000 }).trim().toLowerCase();
      if (/^[0-9a-f]{40}$/.test(sha)) value = sha;
    }
  } catch {
    value = null;
  }
  value ??= fallback();
  cachedSync = { at: nowMs, value };
  return value;
}
