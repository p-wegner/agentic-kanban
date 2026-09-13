#!/usr/bin/env node
/**
 * Prune dead worktree HUSKS (#1126).
 *
 * `git worktree remove` deletes tracked files; `node_modules` is untracked, so a worktree that
 * lost its `git worktree list` entry (an EBUSY-failed remove, a manually deleted `.git` file, a
 * workspace row that was deleted without the worktree cleanup running) can still sit on disk
 * holding tens of thousands of hard links into the shared pnpm store — exactly what pushes a
 * store file toward the NTFS 1024-link ceiling `scripts/pnpm-store-health.mjs` warns about.
 *
 * A directory under `.worktrees/<project>/` is a HUSK when BOTH are true:
 *   1. it has no entry in `git worktree list` for the project's repo, AND
 *   2. no `workspaces` row's `working_dir` points at it.
 * Checking both (not just `git worktree list`, which `scripts/cleanup-orphan-worktrees.ps1`
 * already does) catches the case a git-list-only check misses: a workspace the board still
 * knows about but whose git worktree entry is already gone.
 *
 * Deletion goes through `scripts/safe-rmdir.mjs` (imported as a library), never a raw
 * `rd`/`rm -rf` — it refuses a tree holding a reparse point that points OUTSIDE itself, which is
 * exactly the borrowed-`node_modules` shape that has corrupted a live checkout before (#1033).
 *
 * Usage:
 *   node scripts/prune-worktree-husks.mjs <worktreesRoot> --repo <repoDir> [--db <dbPath>] [--dry-run] [--json]
 *
 *   worktreesRoot  the directory holding worktree leaf dirs directly, e.g. `.worktrees/agentic-kanban`
 *   --repo         the repo those worktrees belong to (defaults to the parent of worktreesRoot's parent)
 *   --db           path to kanban.db (defaults to <repo>/packages/server/kanban.db, then
 *                  ~/.agentic-kanban/kanban.db — the same fallback order the server itself uses)
 *   --dry-run      report husks found, delete nothing
 *   --json         one machine-readable result line
 *
 * Plain node, no package resolution.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gitExecSync } from "./git-exec.mjs";
import { safeRmdir } from "./safe-rmdir.mjs";

function normKey(p) {
  const s = resolve(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
}

/** Every worktree leaf directory directly under `worktreesRoot`. */
export function listCandidateDirs(worktreesRoot) {
  let entries;
  try {
    entries = readdirSync(worktreesRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => resolve(join(worktreesRoot, e.name)));
}

/** `git worktree list --porcelain` paths for `repoDir`, as absolute paths. */
export function getLiveWorktreePaths(repoDir) {
  const out = gitExecSync(["worktree", "list", "--porcelain"], { cwd: repoDir });
  const paths = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) paths.push(resolve(line.slice("worktree ".length).trim()));
  }
  return paths;
}

/** `workspaces.working_dir` values from the board DB, as absolute paths. */
export function getWorkspaceWorkingDirs(dbPath) {
  if (!existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT working_dir FROM workspaces WHERE working_dir IS NOT NULL").all();
    return rows.map((r) => resolve(String(r.working_dir)));
  } finally {
    db.close();
  }
}

/**
 * Pure function — given the candidate worktree dirs and the two "claimed" sets, returns the
 * dirs claimed by NEITHER (the husks).
 */
export function findHuskDirs(candidateDirs, liveWorktreePaths, workspaceWorkingDirs) {
  const live = new Set(liveWorktreePaths.map(normKey));
  const claimed = new Set(workspaceWorkingDirs.map(normKey));
  return candidateDirs.filter((dir) => !live.has(normKey(dir)) && !claimed.has(normKey(dir)));
}

function resolveDefaultDb(repoDir) {
  const local = join(repoDir, "packages", "server", "kanban.db");
  if (existsSync(local)) return local;
  return join(homedir(), ".agentic-kanban", "kanban.db");
}

function main(argv) {
  const args = argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const positional = args.filter((a) => !a.startsWith("--") && !a.includes("="));
  const getOpt = (name) => {
    const withEq = args.find((a) => a.startsWith(`--${name}=`));
    if (withEq) return withEq.slice(name.length + 3);
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith("--") ? args[idx + 1] : undefined;
  };

  const worktreesRoot = positional[0];
  if (!worktreesRoot) {
    console.error("usage: node scripts/prune-worktree-husks.mjs <worktreesRoot> --repo <repoDir> [--db <dbPath>] [--dry-run] [--json]");
    return 1;
  }
  const repoDir = resolve(getOpt("repo") ?? resolve(dirname(resolve(worktreesRoot)), ".."));
  const dbPath = resolve(getOpt("db") ?? resolveDefaultDb(repoDir));
  const dryRun = flags.has("--dry-run");
  const json = flags.has("--json");

  const candidates = listCandidateDirs(worktreesRoot);
  let live = [];
  try {
    live = getLiveWorktreePaths(repoDir);
  } catch (err) {
    console.error(`prune-worktree-husks: could not read git worktree list in ${repoDir}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const claimed = getWorkspaceWorkingDirs(dbPath);
  const husks = findHuskDirs(candidates, live, claimed);

  const results = husks.map((dir) => ({ dir, ...safeRmdir(dir, { dryRun }) }));
  const deleted = results.filter((r) => r.ok && r.deleted).length;
  const refused = results.filter((r) => r.refused);

  if (json) {
    console.log(JSON.stringify({ worktreesRoot, repoDir, dbPath, dryRun, candidates: candidates.length, husks: husks.length, results }));
  } else {
    console.log(`prune-worktree-husks: ${candidates.length} candidate(s), ${husks.length} husk(s) found in ${worktreesRoot}`);
    for (const r of results) {
      if (r.refused) console.warn(`  REFUSED ${r.dir} — outbound reparse point(s), see safe-rmdir output`);
      else if (dryRun) console.log(`  would delete ${r.dir}`);
      else console.log(`  deleted ${r.dir}`);
    }
    if (refused.length) console.warn(`${refused.length} husk(s) refused (outbound reparse points) — resolve manually.`);
  }
  return refused.length > 0 ? 2 : 0;
}

if (process.argv[1] && /prune-worktree-husks\.mjs$/i.test(process.argv[1])) {
  process.exit(main(process.argv));
}
