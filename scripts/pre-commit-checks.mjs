#!/usr/bin/env node
// Pre-commit checks (#1604), run by .githooks/pre-commit in every checkout/worktree (a git hook, so
// Codex sessions get it too). Surfaces the god-module ceiling and the cheap static ratchets at
// commit time, in the builder's own turn, instead of at implement-exit or the train.
//   1. skills mirror (#1576)
//   2. check-god-modules.mjs on the STAGED files only (line ceiling needs no deps; branch count uses typescript when present)
//   3. @gate:always-run ratchets whose `when:` territory the staged files match, within a 10 s budget
// Fails OPEN on anything that is not a verdict (no deps, timeout, spawn error); only a completed non-zero exit blocks.
// Bypass for a genuine emergency: git commit --no-verify.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GUARD_BUDGET_MS = 10_000;
const SOURCE = /^packages\/[^/]+\/src\/.*\.tsx?$/;

function run(args, opts = {}) {
  return spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit", windowsHide: true, ...opts });
}

export function stagedFiles() {
  const r = spawnSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], { cwd: ROOT, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) return [];
  return r.stdout.split(/\r?\n/).map((f) => f.trim()).filter(Boolean);
}

export function main() {
  if (process.env.KANBAN_SKIP_PRECOMMIT_CHECKS) return 0;
  if (run([join(ROOT, "scripts", "skills-mirror.mjs"), "--check"]).status !== 0) return 1;

  const staged = stagedFiles();
  const sources = staged.filter((f) => SOURCE.test(f));
  if (sources.length > 0 && existsSync(join(ROOT, "scripts", "check-god-modules.mjs"))) {
    const r = run([join(ROOT, "scripts", "check-god-modules.mjs"), "--files", sources.join(",")]);
    // 3 = UNVERIFIED (no typescript): not a verdict, never blocks a commit.
    if (r.status === 1) {
      console.error("[pre-commit] god-module guard failed on staged files — fix above, re-stage, commit again.");
      return 1;
    }
  }

  if (staged.length > 0 && existsSync(join(ROOT, "node_modules")) && existsSync(join(ROOT, "scripts", "test-mine.mjs"))) {
    const r = run([join(ROOT, "scripts", "test-mine.mjs")], {
      timeout: GUARD_BUDGET_MS,
      killSignal: "SIGKILL",
      env: { ...process.env, KANBAN_TEST_GUARDS_ONLY: "1", KANBAN_TEST_GUARDS: "intersecting", KANBAN_TEST_FILES: staged.join(",") },
    });
    if (r.error || r.signal) {
      console.error(`[pre-commit] ratchet check exceeded ${GUARD_BUDGET_MS / 1000}s or could not run — skipped (the train still runs it).`);
    } else if (r.status !== 0) {
      console.error("[pre-commit] a ratchet whose territory your staged files touch failed — fix above, re-stage, commit again.");
      return 1;
    }
  }
  return 0;
}

process.exit(main());
