#!/usr/bin/env node
// Check for uncommitted changes when a session stops.
//
// Two cases, split by whether the stopping session owns a tracked workspace:
//
//  1. Tracked agent session (session_id maps to an active workspace):
//     check THAT workspace's worktree for any uncommitted changes.
//
//  2. Non-workspace session (interactive user, butler, or a manually-launched
//     orchestrator/monitor session — i.e. anything operating in the MAIN
//     checkout): check the MAIN checkout for uncommitted *tracked source*
//     changes. This catches the failure mode where a long-running session
//     fixes code in the main checkout but never commits it — the fixes get
//     stranded, block auto-merge, and can be lost (the codex-monitor incident).
//     Scoped to tracked packages/**/*.{ts,tsx,sql} so untracked screenshots,
//     docs, and lock-file churn don't trip it.

const { execFileSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const { resolve } = require("path");
const { existsSync } = require("fs");
const readline = require("readline");

// packages/**/*.{ts,tsx,sql} — the source/migration files whose stranding
// actually breaks builds, blocks merges, or silently loses fixes.
const SOURCE_RE = /^packages\/.+\.(ts|tsx|sql)$/;

function gitPorcelain(cwd) {
  try {
    return execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
  } catch {
    return "";
  }
}

// Tracked (not "??") changes to source files, classified by whether each is a
// DELETION (file removed from the working tree) or an EDIT/ADD. A working tree
// that is dominated by deletions is a desync to RESTORE, never a set of changes
// to commit (#771): a board merge whose working-tree sync regressed can leave
// 100+ tracked source files showing as `D` while HEAD still contains them.
// Committing them would DELETE packages/shared from the branch — so the hook must
// tell the agent to investigate/restore, not "commit before stopping".
function trackedSourceChanges(cwd) {
  const edited = [];
  const deleted = [];
  for (const line of gitPorcelain(cwd).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const xy = line.slice(0, 2);
    if (xy === "??") continue; // untracked — ignore
    let p = line.slice(3).trim();
    if (p.includes(" -> ")) p = p.split(" -> ")[1].trim(); // rename
    p = p.replace(/\\/g, "/").replace(/^"|"$/g, "");
    if (!SOURCE_RE.test(p)) continue;
    // Porcelain status: a deletion is `D` in either the staged (X) or unstaged (Y)
    // column (" D", "D ", "AD", etc.). Anything else is an edit/add/rename target.
    if (xy.includes("D")) deleted.push(p);
    else edited.push(p);
  }
  return { edited, deleted, all: [...edited, ...deleted] };
}

// Decide what the Stop hook should report for a non-workspace (main-checkout)
// session, given the classified tracked source changes. Pure + side-effect-free so
// the deletion-vs-edit logic is unit-testable without spawning git (#771).
//   - { action: "ok" }       → nothing stranded, let the session stop.
//   - { action: "restore" }  → deletion-dominant desync; tell the agent to RESTORE.
//   - { action: "commit" }   → genuine stranded edits; tell the agent to COMMIT.
function classifyStranded({ edited, deleted, all }) {
  if (all.length === 0) return { action: "ok" };
  // Deletion-dominant working tree: more (or equal) tracked source files DELETED
  // than edited — the signature of a merge working-tree desync, not stranded fixes.
  if (deleted.length > 0 && deleted.length >= edited.length) {
    return { action: "restore", edited, deleted };
  }
  return { action: "commit", files: all };
}

if (require.main !== module) {
  module.exports = { trackedSourceChanges, classifyStranded, SOURCE_RE };
}

function lookupWorkspace(sessionId) {
  const DB_PATH = resolve(__dirname, "../../packages/server/kanban.db");
  if (!sessionId || !existsSync(DB_PATH)) return null;
  let db;
  try {
    db = new DatabaseSync(DB_PATH);
  } catch {
    return null; // DB locked or corrupt — skip
  }
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspaces'")
      .all();
    if (tables.length === 0) return null;
    const rows = db
      .prepare(
        "SELECT w.branch, w.working_dir, i.title FROM sessions s " +
          "JOIN workspaces w ON s.workspace_id = w.id " +
          "JOIN issues i ON w.issue_id = i.id " +
          "WHERE s.id = ? AND w.status = 'active'"
      )
      .all(sessionId);
    return rows.length > 0 ? rows[0] : null;
  } finally {
    if (db) db.close();
  }
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin });
  const lines = [];
  for await (const line of rl) lines.push(line);
  let input = {};
  try {
    input = JSON.parse(lines.join(""));
  } catch {}

  // Loop safety: when a Stop hook is wired directly (e.g. codex .codex/hooks.json,
  // which fires per-turn and can "continue" the turn on a non-zero exit), only
  // nudge on the first stop. On re-entry (stop_hook_active=true) let it through.
  // For Claude this is redundant — smart-hooks-runner already skips non-alwaysRun
  // checks on re-prompt — but harmless.
  if (input.stop_hook_active === true) process.exit(0);

  const ws = lookupWorkspace(input.session_id);

  if (ws) {
    // Case 1: tracked agent session — check its worktree.
    if (!ws.working_dir || !existsSync(ws.working_dir)) process.exit(0);
    if (gitPorcelain(ws.working_dir).trim()) {
      console.error("WARNING: Uncommitted changes found in active worktree:");
      console.error(`  - ${ws.branch} (${ws.title})`);
      console.error("Commit or stash changes before stopping.");
      process.exit(1);
    }
    process.exit(0);
  }

  // Case 2: non-workspace session — check the MAIN checkout for stranded source fixes.
  const mainCheckout = resolve(__dirname, "..", "..");
  const verdict = classifyStranded(trackedSourceChanges(mainCheckout));

  if (verdict.action === "ok") process.exit(0);

  if (verdict.action === "restore") {
    // Deletion-dominant working tree (#771): a merge working-tree desync, NOT stranded
    // fixes. Committing here would remove those files from the branch (e.g. wipe
    // packages/shared). Tell the agent to investigate/restore, never to commit.
    const { deleted, edited } = verdict;
    console.error(
      `WARNING: ${deleted.length} tracked source file(s) are DELETED from the MAIN checkout working tree` +
        (edited.length > 0 ? ` (alongside ${edited.length} edit(s))` : "") + ":"
    );
    for (const f of deleted.slice(0, 10)) console.error(`  - D ${f}`);
    if (deleted.length > 10) console.error(`  - ... and ${deleted.length - 10} more`);
    console.error(
      "This looks like a working-tree DESYNC (e.g. a board merge that regressed the working tree), " +
        "NOT stranded fixes. Do NOT commit — committing would delete these files from the branch. " +
        "Investigate and restore with `git restore <paths>` (or `git restore packages/shared`), then verify the backend is up."
    );
    process.exit(1);
  }

  // verdict.action === "commit": genuine stranded edits.
  console.error("WARNING: Uncommitted source changes in the MAIN checkout:");
  for (const f of verdict.files) console.error(`  - ${f}`);
  console.error(
    "Commit them before stopping — stranded fixes here block auto-merge and can be lost."
  );
  process.exit(1);
}

main().catch(() => process.exit(0));
