#!/usr/bin/env node
/**
 * Command Safety Validation — guard the vital dev database before execution.
 *
 * Runs as a PreToolUse hook on Bash/PowerShell commands. If a command could
 * erase or overwrite kanban.db, it:
 *   1. Auto-creates a timestamped backup (db + -wal + -shm) — so data is never
 *      lost even if the operation later proceeds.
 *   2. BLOCKS the command and reminds the agent to double-check and confirm
 *      with the user before doing anything destructive to the database.
 *
 * Design notes (lessons from 2026-05-24, see docs/learnings/):
 *   - Detection is decoupled: "references the db file" AND "has a destructive
 *     verb" anywhere in the command. This catches path-evasion (e.g. WSL
 *     `/mnt/c/.../kanban.db`) because the filename is still present.
 *   - Covers truncation/overwrite verbs (Out-File, Set-Content, Clear-Content,
 *     New-Item -Force, `>` redirect, Move-Item/mv), not just deletion.
 *   - NO size-based exemption. A small DB during a migration failure is exactly
 *     when a human must decide — not a heuristic the agent can satisfy by first
 *     truncating the file.
 *   - The ONLY bypass is an explicit, user-set env var (ALLOW_DB_DESTROY=1).
 *     Even then a backup is taken first. Do NOT bypass by editing this file.
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");

function getProjectDir() {
  return process.env.CLAUDE_PROJECT_DIR || "C:\\andrena\\agentic-kanban";
}

function getDbPath() {
  return path.join(getProjectDir(), "packages", "server", "kanban.db");
}

// References to the vital database file, in any path form (Windows, POSIX, WSL).
const DB_REFERENCE = [
  /kanban\.db/i,
  /packages[\/\\]server[\/\\][^\s"']*\.db\b/i,
];

// Destructive verbs that could erase or overwrite a file. Word-boundary anchored
// so SQL like "DELETE FROM" does not trip the `del` verb.
const DESTRUCTIVE_VERB = [
  /\brm\b/i,                     // rm, rm -f, rm -rf
  /\bRemove-Item\b/i,
  /\bri\b/,                      // PS alias for Remove-Item
  /\bdel\b/i,                    // cmd del (not "DELETE")
  /\berase\b/i,
  /\bunlink\b/i,
  /\bOut-File\b/i,               // truncate/overwrite
  /\bSet-Content\b/i,
  /\bsc\b\s+-Path/i,             // Set-Content alias when used on a path
  /\bClear-Content\b/i,
  /\bclc\b/i,                    // Clear-Content alias
  /\bNew-Item\b[^\n]*-Force/i,   // New-Item -Force truncates an existing file
  /\bni\b[^\n]*-Force/i,
  /\bMove-Item\b/i,              // moving the db away erases it in place
  /\bmv\b/i,
  /\bmove\b/i,
  /[^>\d]>\s*[^>]/,              // shell `>` redirect (overwrite); excludes 2>&1 / >>
];

function referencesDb(command) {
  return DB_REFERENCE.some((re) => re.test(command));
}

function hasDestructiveVerb(command) {
  return DESTRUCTIVE_VERB.some((re) => re.test(command));
}

function isDbResetCommand(command) {
  return /pnpm\s+db:reset/i.test(command) || /db:reset/i.test(command);
}

function isDangerous(command) {
  if (isDbResetCommand(command)) return true;
  if (referencesDb(command) && hasDestructiveVerb(command)) {
    // A `>` redirect that only targets a log file (not the db) is a false positive
    // unless the db is also referenced — but we already require referencesDb, so a
    // command mentioning kanban.db AND containing a redirect is genuinely suspect.
    return true;
  }
  // Glob deletions that could sweep up the db (e.g. rm *.db, del *.db).
  if (hasDestructiveVerb(command) && /\*[^\s"']*\.db\b/i.test(command)) return true;
  return false;
}

/** Best-effort timestamped backup of the db and its WAL/SHM sidecars. Returns the backup dir or null. */
function backupDatabase() {
  const dbPath = getDbPath();
  try {
    const stat = fs.statSync(dbPath);
    if (stat.size === 0) return null; // nothing meaningful to back up
  } catch {
    return null; // db doesn't exist — nothing to back up
  }

  try {
    const backupDir = path.join(getProjectDir(), "packages", "server", ".db-backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    for (const suffix of ["", "-wal", "-shm"]) {
      const src = dbPath + suffix;
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(backupDir, `kanban-${stamp}.db${suffix}`));
      }
    }
    pruneBackups(backupDir, 10);
    return backupDir;
  } catch {
    return null;
  }
}

/** Keep only the newest `keep` backup sets (by timestamp prefix). */
function pruneBackups(dir, keep) {
  try {
    const stamps = new Set();
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^kanban-(.+?)\.db(?:-wal|-shm)?$/);
      if (m) stamps.add(m[1]);
    }
    const sorted = [...stamps].sort(); // ISO timestamps sort chronologically
    const toRemove = sorted.slice(0, Math.max(0, sorted.length - keep));
    for (const stamp of toRemove) {
      for (const suffix of ["", "-wal", "-shm"]) {
        const f = path.join(dir, `kanban-${stamp}.db${suffix}`);
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
    }
  } catch {
    /* non-fatal */
  }
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin });
  const lines = [];
  for await (const line of rl) lines.push(line);

  let input = {};
  try {
    input = JSON.parse(lines.join(""));
  } catch {
    process.exit(0);
  }

  const command = input.command || input.Command || "";
  if (!isDangerous(command)) process.exit(0);

  // Always create a backup first, regardless of what happens next.
  const backupDir = backupDatabase();
  const backupNote = backupDir
    ? `A safety backup was just created in:\n  ${backupDir}`
    : `(No backup created — the db was missing or empty.)`;

  // Explicit, user-set override. Backup still taken above. The agent must NOT set
  // this itself to get past the guard — it exists for a human to authorize recovery.
  if (process.env.ALLOW_DB_DESTROY === "1") {
    console.error("[safety] ALLOW_DB_DESTROY=1 set — permitting destructive db op (backup taken).");
    console.error(backupNote);
    process.exit(0);
  }

  console.error("[safety] ⛔ Destructive database operation blocked.");
  console.error("");
  console.error("Command:");
  console.error(`  ${command.substring(0, 160)}${command.length > 160 ? "..." : ""}`);
  console.error("");
  console.error(backupNote);

  console.log(
    JSON.stringify({
      decision: "block",
      reason:
        "⛔ This command could ERASE or OVERWRITE the vital dev database (kanban.db).\n\n" +
        backupNote +
        "\n\nSTOP and double-check before proceeding:\n" +
        "  1. Deletion does NOT fix 'migrations didn't run' or a locked db — check for\n" +
        "     orphaned tsx/node processes holding the file lock first.\n" +
        "  2. To delete individual records, use MCP tools or the REST API, never the file.\n" +
        "  3. If a full reset is genuinely required, CONFIRM WITH THE USER first.\n\n" +
        "Do NOT bypass this guard by editing the hook, truncating the file, or using an\n" +
        "alternate path. If the user authorizes a reset, they (or you, on their explicit\n" +
        "instruction) can re-run with ALLOW_DB_DESTROY=1 — a backup is taken either way.",
    })
  );
  process.exit(1);
}

main().catch(() => process.exit(0));
