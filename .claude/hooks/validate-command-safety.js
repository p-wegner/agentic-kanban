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
const { execSync } = require("child_process");
const readline = require("readline");

let hookInput = {};

function getProjectDir() {
  const startDir = process.env.CLAUDE_PROJECT_DIR || hookInput.cwd || "C:\\andrena\\agentic-kanban";
  try {
    return execSync("git rev-parse --show-toplevel", {
      cwd: startDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
  } catch {
    return startDir;
  }
}

function getDbProjectDir() {
  const mainCheckout = process.env.KANBAN_MAIN_CHECKOUT || "C:\\andrena\\agentic-kanban";
  if (fs.existsSync(path.join(mainCheckout, "packages", "server"))) return mainCheckout;
  return getProjectDir();
}

function getDbPath() {
  return path.join(getDbProjectDir(), "packages", "server", "kanban.db");
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

function usesBrokenRelatedFlag(command) {
  if (!/--related\b/i.test(command)) return false;
  return /\bvitest\b/i.test(command) || /\btest:mine\b/i.test(command) || /\bpnpm\b[^\n]*(?:\btest\b|\bexec\s+vitest\b)/i.test(command);
}

function commandMovesToMainCheckout(command) {
  return /\b(?:cd|Set-Location|Push-Location)\s+["']?C:[\/\\]andrena[\/\\]agentic-kanban\b/i.test(command);
}

function isWorktreeProjectDir() {
  return /[\/\\]\.worktrees[\/\\]/i.test(getProjectDir());
}

function usesWorktreeCli(command) {
  if (!isWorktreeProjectDir()) return false;
  if (commandMovesToMainCheckout(command)) return false;
  return /(?:^|[;&|]\s*)pnpm(?:\.cmd)?\s+cli\s+--(?:\s|$)/i.test(command);
}

function isBroadNodeKill(command) {
  const normalized = command.replace(/\r\n/g, "\n");

  // Whole-node kills are never acceptable in this repo; they can terminate the
  // board, worktree dev servers, MCP helpers, and unrelated agents.
  if (/\bStop-Process\b[^\n|;]*(?:-Name\s+node\b|node\.exe\b)/i.test(normalized)) return true;
  if (/\btaskkill\b[^\n|;]*(?:\/IM\s+node(?:\.exe)?\b)/i.test(normalized)) return true;
  if (/\bGet-Process\b[^\n|;]*\bnode\b[\s\S]*\bStop-Process\b/i.test(normalized)) return true;
  if (/\b(?:pkill|killall)\b[^\n|;]*\bnode\b/i.test(normalized)) return true;

  // These command-line-only process filters are too broad for worktree cleanup:
  // worktree agents can match and kill the main checkout server/client.
  const hasBroadDevMatcher =
    /CommandLine\s+-like\s+["']?\*dev\.mjs\*/i.test(normalized) ||
    /CommandLine\s+-like\s+["']?\*vite\/bin\/vite\.js\*/i.test(normalized) ||
    /CommandLine\s+-like\s+["']?\*agentic-kanban\*tsx\*src\/index\*/i.test(normalized) ||
    /CommandLine\s+-like\s+["']?\*agentic-kanban\*tsx\*src\\index\*/i.test(normalized);
  const killsMatches = /\b(?:taskkill|Stop-Process)\b/i.test(normalized);
  // Exempt the dev-server skill's own Stop-PortOwner recipe: it derives target PIDs
  // from a specific listening port and kills them by /PID, so it is inherently
  // port-scoped. The `CommandLine -like "*dev.mjs*"` it contains is only used to walk
  // from the port owner up to its supervisor parent, not to select processes broadly.
  return hasBroadDevMatcher && killsMatches && !isPortScopedKill(normalized);
}

// True when a command derives the PID(s) it kills from a specific listening port
// (netstat / Get-NetTCPConnection) and kills by /PID — the safe, port-scoped pattern,
// not a broad command-line sweep. (Killing the *main board* port from a worktree is
// still independently blocked by isMainBoardPortKill.)
function isPortScopedKill(normalized) {
  const derivesPidsFromPort =
    /\bGet-NetTCPConnection\b[\s\S]*-LocalPort\b/i.test(normalized) ||
    (/\bnetstat\b[\s\S]*-ano\b/i.test(normalized) && /\b(?:Select-String|findstr)\b/i.test(normalized));
  const killsByPid =
    /\btaskkill\b[\s\S]*\/PID\b/i.test(normalized) ||
    /\bStop-Process\b[\s\S]*-Id\b/i.test(normalized);
  return derivesPidsFromPort && killsByPid;
}

function isMainBoardPortKill(command) {
  if (!isWorktreeProjectDir()) return false;
  const normalized = command.replace(/\r\n/g, "\n");
  const killsMatches = /\b(?:taskkill|Stop-Process|kill\s+-9)\b/i.test(normalized);
  if (!killsMatches) return false;

  return (
    /\bGet-NetTCPConnection\b[\s\S]*(?:-LocalPort\s+3001|\$env:KANBAN_BOARD_SERVER_PORT)\b/i.test(normalized) ||
    /\bnetstat\b[\s\S]*(?::3001|\$env:KANBAN_BOARD_SERVER_PORT)[\s\S]*\b(?:taskkill|Stop-Process)\b/i.test(normalized) ||
    /\blsof\b[\s\S]*:3001[\s\S]*\bkill\s+-9\b/i.test(normalized)
  );
}

function getBlockedNonDbReason(command) {
  if (isBroadNodeKill(command)) {
    return (
      "Broad Node/dev-server process kills are blocked. They can take down the main board server " +
      "or other agents' worktree servers.\n\n" +
      "Use port-scoped cleanup for only this checkout's ports. In this repo, use the dev-server " +
      "skill's Stop-PortOwner recipe with $KANBAN_SERVER_PORT / $KANBAN_CLIENT_PORT, or stop the " +
      "specific workspace through the board API."
    );
  }

  if (isMainBoardPortKill(command)) {
    return (
      "Stopping the main board port from a worktree is blocked. Port 3001 / " +
      "$KANBAN_BOARD_SERVER_PORT belongs to the orchestration board, not the worktree dev server.\n\n" +
      "Use $KANBAN_WORKTREE_SERVER_PORT / $KANBAN_WORKTREE_CLIENT_PORT for worktree dev-server cleanup."
    );
  }

  if (usesBrokenRelatedFlag(command)) {
    return (
      "Vitest 4 does not support the --related flag. Use the related subcommand instead:\n" +
      "  cd packages/server && pnpm exec vitest related src/services/foo.service.ts\n\n" +
      "For the reliable-suite wrapper, use:\n" +
      "  pnpm test:mine -- --changed HEAD"
    );
  }

  if (usesWorktreeCli(command)) {
    return (
      "`pnpm cli --` is unreliable from git worktrees because the server package can use the wrong " +
      "or missing shared build context. Use MCP tools, REST on the running server, or run the CLI " +
      "from the main checkout:\n" +
      "  cd C:\\andrena\\agentic-kanban && pnpm cli -- <command>"
    );
  }

  return null;
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
    const backupDir = path.join(getDbProjectDir(), "packages", "server", ".db-backups");
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

  try {
    hookInput = JSON.parse(lines.join(""));
  } catch {
    process.exit(0);
  }

  const command =
    hookInput.command ||
    hookInput.Command ||
    hookInput.tool_input?.command ||
    hookInput.tool_input?.Command ||
    "";
  const nonDbReason = getBlockedNonDbReason(command);
  if (nonDbReason) {
    console.error("[safety] Command blocked.");
    console.error("");
    console.error("Command:");
    console.error(`  ${command.substring(0, 160)}${command.length > 160 ? "..." : ""}`);

    console.log(
      JSON.stringify({
        decision: "block",
        reason: nonDbReason,
      })
    );
    process.exit(1);
  }

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
