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

  // Check all ports in a single PowerShell call to avoid per-port spawn overhead.
  // Only flag a port whose owning process is actually a dev server (node) — a
  // foreign system service (e.g. TeamViewer holds 5939, which collides with a
  // worktree's computed 5173+N port) is NOT ours to kill, can't be killed
  // without admin, and would otherwise wedge every Stop in that worktree.
  const DEV_SERVER_PROCS = new Set(["node"]);
  try {
    const portList = ports.join(",");
    const output = execSync(
      `powershell.exe -NoProfile -Command "Get-NetTCPConnection -LocalPort ${portList} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; '{0} {1}' -f $_.LocalPort, $p.ProcessName } | Sort-Object -Unique"`,
      {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    // Each line is "<port> <processName>"; keep only node-owned listeners.
    const devServerPorts = new Set();
    for (const line of output.split(/\r?\n/)) {
      const [portStr, procName] = line.trim().split(/\s+/);
      if (!portStr) continue;
      if (procName && DEV_SERVER_PROCS.has(procName.toLowerCase())) {
        devServerPorts.add(portStr);
      }
    }
    for (const p of ports) {
      if (devServerPorts.has(String(p))) runningPorts.push(p);
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
