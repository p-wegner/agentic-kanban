#!/usr/bin/env node
/**
 * Run (or, by default, DRY-RUN) the `issue_comments` retention pass — #738.
 *
 *   node scripts/comment-retention.mjs                          # dry run, default policy
 *   node scripts/comment-retention.mjs --retain-days 60         # dry run, wider window
 *   node scripts/comment-retention.mjs --keep-per-thread 3      # dry run, higher floor
 *   node scripts/comment-retention.mjs --apply                  # actually delete
 *
 * Dry by default and it prints exactly what it would remove, because the rows are board
 * history and DELETE has no undo short of a backup. The policy itself (which authors and
 * kinds are sweepable, and every fail-closed edge) lives in
 * packages/server/src/services/issue-comment-retention.service.ts — this file only launches
 * it under tsx, so the runnable thing and the rules cannot drift apart.
 *
 * After --apply: SQLite does not hand freed pages back to the OS on DELETE. `pnpm db:repair`
 * VACUUMs, which is what actually shrinks the file.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = join(repoRoot, "packages", "server");
// Resolve tsx from the server package: pnpm hoists it there, not to the repo root.
const tsx = createRequire(pathToFileURL(join(serverDir, "package.json"))).resolve("tsx/cli");
const entry = join("src", "services", "issue-comment-retention.service.ts");

try {
  execFileSync(process.execPath, [tsx, entry, ...process.argv.slice(2)], {
    cwd: serverDir,
    stdio: "inherit",
  });
} catch (err) {
  process.exit(typeof err?.status === "number" ? err.status : 1);
}
