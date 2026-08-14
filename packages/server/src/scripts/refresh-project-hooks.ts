/**
 * Refresh the board-owned hook scripts in every registered project (#472).
 *
 * `ensureHookScaffold` used to write each hook once and never again, so a guard fix reached only
 * NEWLY registered projects. The version-banner refresh fixes that going forward, but it only
 * runs when something calls the scaffold — which, for an already-registered project, may be
 * never. This is the one-shot sweep for the existing fleet.
 *
 * Safe to re-run: `writeBoardHookIfOutdated` replaces a copy only when the shipped version is
 * strictly newer, so a second pass is a no-op.
 *
 *   pnpm --filter agentic-kanban exec tsx src/scripts/refresh-project-hooks.ts [--dry-run]
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../db/index.js";
import { getAllProjects } from "../repositories/project.repository.js";
import { ensureHookScaffold } from "../services/project-scaffold.js";

const GUARD = "prevent-cross-worktree-writes.js";

function versionOf(repoPath: string): number | null {
  const path = join(repoPath, ".claude", "hooks", GUARD);
  if (!existsSync(path)) return null;
  const match = /^\/\/ @board-hook-version: (\d+)/m.exec(readFileSync(path, "utf8"));
  return match ? Number(match[1]) : 0;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const projects = await getAllProjects(undefined, { includeArchived: true }, db);
  let refreshed = 0;
  let absent = 0;
  for (const project of projects) {
    if (!project.repoPath || !existsSync(project.repoPath)) continue;
    const before = versionOf(project.repoPath);
    if (before === null) {
      // No guard at all. Reported, NOT installed: putting a hook into a repo that never had one
      // is a bigger, more surprising act than refreshing one the operator already opted into
      // (the same line #391/#396 drew). Re-registering the project installs it.
      absent++;
      console.log(`[refresh] ${project.name}: no ${GUARD} — skipped (re-register to install)`);
      continue;
    }
    if (dryRun) {
      console.log(`[refresh] ${project.name}: guard v${before}`);
      continue;
    }
    ensureHookScaffold(project.repoPath);
    const after = versionOf(project.repoPath);
    if (after !== before) {
      refreshed++;
      console.log(`[refresh] ${project.name}: v${before} -> v${after}`);
    }
  }
  console.log(`[refresh] ${refreshed} project(s) refreshed, ${absent} without a guard.`);
}

main().catch((err) => {
  console.error("[refresh] failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
