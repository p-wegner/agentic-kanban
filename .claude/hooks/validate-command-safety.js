#!/usr/bin/env node
/**
 * Command Safety Validation — prevent deletion of vital files before execution
 *
 * Checks Bash/PowerShell commands for destructive operations on:
 *   - kanban.db (the vital dev database)
 *   - Critical schema/migration files
 *
 * Blocks if the command would delete or overwrite these files.
 * Exception: allows deletion of empty/corrupt databases (< 10KB) for recovery.
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");

// Dangerous patterns that would delete/destroy the database
const DANGEROUS_PATTERNS = [
  // Direct database deletion
  /\b(rm|Remove-Item|del|erase|rm -f|rm -rf)\s+.*kanban\.db/i,
  /kanban\.db.*\b(rm|Remove-Item|del|erase|rm -f|rm -rf)\b/i,
  // pnpm db:reset (explicitly forbidden in CLAUDE.md)
  /pnpm\s+db:reset/i,
  // Glob patterns that might catch the database
  /\b(rm|Remove-Item|del)\s+.*\*.*\.db/i,
  // Direct path deletion pointing to server dir
  /\b(rm|Remove-Item|del)\s+.*packages[\/\\]server[\/\\]kanban/i,
  // PowerShell recursive deletion patterns
  /Remove-Item\s+.*-Recurse.*packages.*server/i,
];

// Patterns that are OK (not destructive)
const SAFE_PATTERNS = [
  // Reading the database
  /sqlite3\s+.*kanban\.db/i,
  /SELECT|INSERT|UPDATE|DELETE\s+FROM/i,
  // Backing up is OK
  /cp.*kanban\.db.*backup/i,
  /Copy-Item.*kanban\.db.*backup/i,
];

function isSafeCommand(command) {
  // Check safe patterns first (whitelist)
  for (const pattern of SAFE_PATTERNS) {
    if (pattern.test(command)) {
      return true;
    }
  }

  // Check dangerous patterns
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      // Exception: allow deletion of empty/corrupt databases (< 10KB)
      // This lets us recover from migration failures or initialization issues
      const possiblePaths = [
        "C:\\andrena\\agentic-kanban\\packages\\server\\kanban.db",
        process.env.CLAUDE_PROJECT_DIR ? path.join(process.env.CLAUDE_PROJECT_DIR, "packages/server/kanban.db") : null,
      ].filter(Boolean);

      for (const dbPath of possiblePaths) {
        try {
          const stat = fs.statSync(dbPath);
          if (stat.size < 10240) {
            // Empty/tiny database — safe to delete for recovery
            return true;
          }
        } catch {
          // File doesn't exist or can't stat — safe to delete
          return true;
        }
      }
      return false;
    }
  }

  // Default: safe
  return true;
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

  const command = input.command || "";

  if (!isSafeCommand(command)) {
    console.error("[safety] ❌ Command blocked: destructive operation on vital files");
    console.error("");
    console.error("Detected dangerous pattern in command:");
    console.error(`  ${command.substring(0, 120)}${command.length > 120 ? "..." : ""}`);
    console.error("");
    console.error("The kanban.db database contains vital dev entries and must not be deleted.");
    console.error("Use MCP tools or API to delete individual issues/workspaces instead.");
    console.error("");

    console.log(
      JSON.stringify({
        decision: "block",
        reason:
          "Destructive operation on vital database file blocked.\n\n" +
          "kanban.db contains vital dev entries (workspaces, issues, sessions).\n" +
          "Use MCP tools or API to delete individual records, never the database.\n\n" +
          "If this is intentional, edit the safelist in .claude/hooks/validate-command-safety.js",
      })
    );
    process.exit(1);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
