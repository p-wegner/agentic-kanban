#!/usr/bin/env node

/**
 * Port-aware dev launcher.
 *
 * Detects whether we're in a git worktree and assigns deterministic ports
 * based on the issue number parsed from the branch name.
 *
 * Main checkout: server 3001, client 5173
 * Worktree feature/<N>-...: server 3001+N, client 5173+N
 * Worktree (other): server 3001+hash, client 5173+hash
 */

import { execSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";

const DEFAULT_SERVER_PORT = 3001;
const DEFAULT_CLIENT_PORT = 5173;

function run(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

function detectWorktree() {
  const toplevel = run("git rev-parse --show-toplevel");
  const gitCommonDir = run("git rev-parse --git-common-dir");
  if (!toplevel || !gitCommonDir) return { isWorktree: false, branch: null };
  const resolvedCommon = resolve(toplevel, gitCommonDir);
  const expectedGit = resolve(toplevel, ".git");
  const isWorktree = resolvedCommon !== expectedGit;
  const branch = isWorktree ? run("git branch --show-current") : null;
  return { isWorktree, branch };
}

function getIssueNumber(branchName) {
  const match = branchName.match(/^feature\/(?:ak-)?(\d+)-/);
  return match ? parseInt(match[1], 10) : null;
}

function branchHash(branchName) {
  let hash = 0;
  for (let i = 0; i < branchName.length; i++) {
    hash = (hash * 31 + branchName.charCodeAt(i)) & 0xffff;
  }
  // Use range 101-1000 to avoid collisions with issue numbers 1-100
  return (hash % 900) + 101;
}

const { isWorktree, branch } = detectWorktree();
let serverPort = DEFAULT_SERVER_PORT;
let clientPort = DEFAULT_CLIENT_PORT;

if (isWorktree && branch) {
  const issueNum = getIssueNumber(branch);
  const offset = issueNum !== null ? issueNum : branchHash(branch);
  serverPort = DEFAULT_SERVER_PORT + offset;
  clientPort = DEFAULT_CLIENT_PORT + offset;
  if (serverPort > 60000) {
    console.error(`[dev] ERROR: computed server port ${serverPort} exceeds 60000. Use a different branch name.`);
    process.exit(1);
  }
  console.log(`[dev] Worktree detected (${branch}) — server:${serverPort} client:${clientPort}`);
} else {
  console.log(`[dev] Main checkout — server:${serverPort} client:${clientPort}`);
}

process.env.PORT = String(serverPort);
process.env.VITE_PORT = String(clientPort);
process.env.SERVER_PORT = String(serverPort);
process.env.KANBAN_SERVER_PORT = String(serverPort);
process.env.KANBAN_CLIENT_PORT = String(clientPort);

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => { server.close(); resolve(true); });
    server.listen(port, "127.0.0.1");
  });
}

async function freePort(port, label) {
  if (await isPortFree(port)) return;
  console.warn(`[dev] Port ${port} is in use — killing occupying process...`);
  try {
    // Works on Windows (netstat) and Unix (lsof)
    const isWin = process.platform === "win32";
    if (isWin) {
      const out = execSync(`netstat -ano | findstr ":${port} "`, { encoding: "utf8", stdio: ["pipe","pipe","pipe"] });
      const pids = [...new Set(
        out.split("\n")
          .map(l => l.trim().split(/\s+/).at(-1))
          .filter(p => /^\d+$/.test(p) && p !== "0")
      )];
      for (const pid of pids) {
        try { execSync(`taskkill /PID ${pid} /F`, { stdio: "pipe" }); } catch {}
      }
    } else {
      execSync(`lsof -ti :${port} | xargs kill -9`, { stdio: "pipe" });
    }
  } catch {}
  // Wait up to 3s for the port to free
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await isPortFree(port)) { console.log(`[dev] Port ${port} freed.`); return; }
  }
  console.error(`[dev] Could not free port ${port} — ${label} may fail to start.`);
}

const MAX_RESTARTS = 5;
const RESTART_DELAY_MS = 1000;

function spawnProcess(label, cmd, args, opts) {
  let restarts = 0;

  function start() {
    const proc = spawn(cmd, args, { ...opts, stdio: "inherit", env: process.env });

    proc.on("exit", (code, signal) => {
      if (signal === "SIGINT" || signal === "SIGTERM") return; // clean shutdown
      if (code === 0) return; // intentional exit
      if (restarts >= MAX_RESTARTS) {
        console.error(`[dev] ${label} exited (code=${code}), max restarts reached — giving up`);
        return;
      }
      restarts++;
      console.warn(`[dev] ${label} exited (code=${code}), restarting in ${RESTART_DELAY_MS}ms (attempt ${restarts}/${MAX_RESTARTS})...`);
      setTimeout(start, RESTART_DELAY_MS);
    });

    return proc;
  }

  return start();
}

await freePort(serverPort, "server");
await freePort(clientPort, "client");

const serverProc = spawnProcess(
  "server",
  "pnpm",
  ["--filter", "agentic-kanban", "dev"],
  { shell: false }
);

const clientProc = spawnProcess(
  "client",
  "pnpm",
  ["--filter", "client", "dev"],
  { shell: false }
);

function shutdown() {
  serverProc.kill();
  clientProc.kill();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Keep the event loop alive so Ctrl+C works and children stay supervised.
const keepAlive = setInterval(() => {}, 60_000);
