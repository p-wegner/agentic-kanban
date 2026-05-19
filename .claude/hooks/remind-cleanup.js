#!/usr/bin/env node
/**
 * Stop hook: remind-cleanup.js
 *
 * Blocks agent termination when dev server processes are still running
 * on worktree-specific ports. Reminds the agent to kill them before stopping.
 *
 * Only fires when running in a git worktree (not the main checkout).
 * Detects processes via KANBAN_SERVER_PORT/KANBAN_CLIENT_PORT env vars.
 * Skips default ports (3001/5173) to avoid killing the user's own dev server.
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function getProjectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function main() {
  // Only fire in worktrees — skip main checkout where .git is a directory
  try {
    const gitPath = path.join(getProjectDir(), ".git");
    const stat = fs.statSync(gitPath);
    if (stat.isDirectory()) process.exit(0);
  } catch {
    process.exit(0);
  }

  const serverPort =
    process.env.KANBAN_SERVER_PORT ||
    process.env.SERVER_PORT ||
    process.env.PORT;
  const clientPort =
    process.env.KANBAN_CLIENT_PORT || process.env.VITE_PORT;
  if (!serverPort && !clientPort) process.exit(0);

  // Skip default ports — those belong to the user's main checkout
  if (serverPort === "3001" && (!clientPort || clientPort === "5173"))
    process.exit(0);

  const ports = [serverPort, clientPort].filter(Boolean);
  const runningPorts = [];

  // Check all ports in a single PowerShell call to avoid per-port spawn overhead
  try {
    const portList = ports.join(",");
    const output = execSync(
      `powershell.exe -NoProfile -Command "Get-NetTCPConnection -LocalPort ${portList} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort | Sort-Object -Unique"`,
      {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    const listeningPorts = new Set(
      output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    );
    for (const p of ports) {
      if (listeningPorts.has(String(p))) runningPorts.push(p);
    }
  } catch {
    // PowerShell returned non-zero (no matches) — no ports listening
  }

  if (runningPorts.length === 0) process.exit(0);

  const killCommands = runningPorts
    .map(
      (p) =>
        `  Get-NetTCPConnection -LocalPort ${p} | Select-Object -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force }`
    )
    .join("\n");

  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason: [
        "CLEANUP REQUIRED: Dev server processes still running",
        "",
        "The following ports still have active listeners in your worktree:",
        ...runningPorts.map((p) => `  - Port ${p}`),
        "",
        "Kill these processes before stopping to prevent stuck agent sessions:",
        killCommands,
        "",
        "IMPORTANT: Never kill ALL node processes — other agents may be running in separate worktrees.",
        "Only kill processes on the specific ports listed above.",
        "",
        "After killing the processes, you may stop.",
      ].join("\n"),
    }) + "\n"
  );
  process.exit(2);
}

main();
