#!/usr/bin/env node
// Check for uncommitted changes in the git worktree belonging to the stopping session.
// Only fires when the session is a tracked agent session (has a workspace in the DB).
// Interactive (user) sessions are not in the sessions table, so the check is skipped.

const { execFileSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const { resolve } = require("path");
const { existsSync } = require("fs");
const readline = require("readline");

async function main() {
  // Read hook input from stdin
  const rl = readline.createInterface({ input: process.stdin });
  const lines = [];
  for await (const line of rl) lines.push(line);
  let input = {};
  try { input = JSON.parse(lines.join("")); } catch {}

  const sessionId = input.session_id;

  const DB_PATH = resolve(__dirname, "../../packages/server/kanban.db");
  if (!existsSync(DB_PATH)) process.exit(0);

  const db = new DatabaseSync(DB_PATH);
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspaces'").all();
    if (tables.length === 0) process.exit(0);

    // Look up the workspace for this specific session ID.
    // If not found, this is not a tracked agent session — skip.
    const rows = sessionId
      ? db.prepare(
          "SELECT w.branch, w.working_dir, i.title FROM sessions s JOIN workspaces w ON s.workspace_id = w.id JOIN issues i ON w.issue_id = i.id WHERE s.id = ? AND w.status = 'active'"
        ).all(sessionId)
      : [];

    if (rows.length === 0) process.exit(0);

    const ws = rows[0];
    if (!ws.working_dir || !existsSync(ws.working_dir)) process.exit(0);

    const result = execFileSync("git", ["status", "--porcelain"], {
      cwd: ws.working_dir,
      encoding: "utf8",
      timeout: 5000,
    });

    if (result.trim()) {
      console.error("WARNING: Uncommitted changes found in active worktrees:");
      console.error(`  - ${ws.branch} (${ws.title})`);
      console.error("Commit or stash changes before stopping.");
      process.exit(1);
    }
  } finally {
    db.close();
  }
}

main().catch(() => process.exit(0));
