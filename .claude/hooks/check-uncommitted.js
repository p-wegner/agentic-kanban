#!/usr/bin/env node
// Check for uncommitted changes in git worktrees belonging to active workspaces.
// Exit 0 if clean, exit 1 with warning if uncommitted changes found.

const { execFileSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const { resolve } = require("path");
const { existsSync } = require("fs");

const DB_PATH = resolve(__dirname, "../../packages/server/kanban.db");

if (!existsSync(DB_PATH)) {
  process.exit(0);
}

const db = new DatabaseSync(DB_PATH);

try {
  const workspaces = db
    .prepare("SELECT w.id, w.branch, w.working_dir, w.status, i.title FROM workspaces w JOIN issues i ON w.issue_id = i.id WHERE w.status = 'active'")
    .all();

  if (workspaces.length === 0) {
    process.exit(0);
  }

  let dirty = [];
  for (const ws of workspaces) {
    if (!ws.working_dir || !existsSync(ws.working_dir)) continue;

    try {
      const result = execFileSync("git", ["status", "--porcelain"], {
        cwd: ws.working_dir,
        encoding: "utf8",
        timeout: 5000,
      });
      if (result.trim()) {
        dirty.push({ branch: ws.branch, title: ws.title });
      }
    } catch {
      // git command failed, skip
    }
  }

  if (dirty.length > 0) {
    console.error("WARNING: Uncommitted changes found in active worktrees:");
    for (const d of dirty) {
      console.error(`  - ${d.branch} (${d.title})`);
    }
    console.error("Commit or stash changes before stopping.");
    process.exit(1);
  }
} finally {
  db.close();
}
