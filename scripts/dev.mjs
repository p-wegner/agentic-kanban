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
import { pathToFileURL } from "node:url";
import { classifyProcessExit } from "./dev-supervisor.mjs";
import { planPortOwnerKill } from "./dev-port-guard.mjs";
import { writeProcessAudit } from "./process-audit.mjs";

const DEFAULT_SERVER_PORT = 3001;
const DEFAULT_CLIENT_PORT = 5173;

function run(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], windowsHide: true }).trim();
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

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => { server.close(); resolve(true); });
    server.listen(port, "127.0.0.1");
  });
}

function getProcessCommandLine(pid) {
  try {
    if (process.platform === "win32") {
      const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $p.CommandLine }`;
      return execSync("powershell.exe", ["-NoProfile", "-Command", script], {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }).trim();
    }
    return execSync(`ps -p ${pid} -o command=`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

async function freePort(port, label) {
  if (await isPortFree(port)) return;
  writeProcessAudit({ action: "dev-port-cleanup-start", port, label });
  console.warn(`[dev] Port ${port} is in use — killing occupying process...`);
  try {
    // Works on Windows (netstat) and Unix (lsof)
    const isWin = process.platform === "win32";
    if (isWin) {
      const out = execSync(`netstat -ano | findstr ":${port} "`, { encoding: "utf8", stdio: ["pipe","pipe","pipe"], windowsHide: true });
      const pids = [...new Set(
        out.split("\n")
          .map(l => l.trim().split(/\s+/).at(-1))
          .filter(p => /^\d+$/.test(p) && p !== "0")
      )];
      for (const pid of pids) {
        const decision = planPortOwnerKill({
          pid,
          port,
          checkoutRoot: process.cwd(),
          getCommandLine: getProcessCommandLine,
          audit: writeProcessAudit,
        });
        if (!decision.allowed) {
          console.error(
            `[dev] Refusing to kill pid ${pid} on port ${port}: it does not belong to this checkout (${process.cwd()}). ` +
            `CommandLine=${decision.commandLine || "<unknown>"}`
          );
          continue;
        }
        try {
          execSync(`taskkill /PID ${pid} /T /F`, { stdio: "pipe", windowsHide: true });
          writeProcessAudit({ action: "dev-port-kill-succeeded", port, pid, label });
        } catch (err) {
          writeProcessAudit({ action: "dev-port-kill-failed", port, pid, label, error: err instanceof Error ? err.message : String(err) });
        }
      }
    } else {
      const out = execSync(`lsof -ti :${port}`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
      const pids = [...new Set(out.split("\n").map((p) => p.trim()).filter(Boolean))];
      for (const pid of pids) {
        const decision = planPortOwnerKill({
          pid,
          port,
          checkoutRoot: process.cwd(),
          getCommandLine: getProcessCommandLine,
          audit: writeProcessAudit,
        });
        if (!decision.allowed) {
          console.error(`[dev] Refusing to kill pid ${pid} on port ${port}: it does not belong to this checkout (${process.cwd()}).`);
          continue;
        }
        try {
          execSync(`kill -9 ${pid}`, { stdio: "pipe" });
          writeProcessAudit({ action: "dev-port-kill-succeeded", port, pid, label });
        } catch (err) {
          writeProcessAudit({ action: "dev-port-kill-failed", port, pid, label, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  } catch (err) {
    writeProcessAudit({ action: "dev-port-cleanup-error", port, label, error: err instanceof Error ? err.message : String(err) });
  }
  // Wait up to 3s for the port to free
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await isPortFree(port)) { console.log(`[dev] Port ${port} freed.`); return; }
  }
  writeProcessAudit({ action: "dev-port-cleanup-not-freed", port, label });
  console.error(`[dev] Could not free port ${port} — ${label} may fail to start.`);
}

const MAX_RESTARTS = 5;
const RESTART_DELAY_MS = 1000;

function configurePorts() {
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
  process.env.KANBAN_BOARD_SERVER_PID = String(process.pid);
  process.env.KANBAN_PROTECTED_PIDS = [process.env.KANBAN_PROTECTED_PIDS, String(process.pid)]
    .filter(Boolean)
    .join(",");

  writeProcessAudit({
    action: "dev-launch-configured",
    isWorktree,
    branch,
    serverPort,
    clientPort,
  });

  return { serverPort, clientPort };
}

function spawnProcess(label, cmd, args, opts) {
  let restarts = 0;

  function start() {
    const proc = spawn(cmd, args, { ...opts, stdio: "inherit", env: process.env });

    proc.on("exit", (code, signal) => {
      const exitType = classifyProcessExit(code, signal);
      if (exitType === "clean") return;
      if (exitType === "fatal") {
        console.error(`[dev] ${label} exited with fatal error (code=1) — not retrying`);
        return;
      }
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

async function main() {
  const { serverPort, clientPort } = configurePorts();

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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

// Keep the event loop alive so Ctrl+C works and children stay supervised.
const keepAlive = setInterval(() => {}, 60_000);
export function shutdownForTests() {
  clearInterval(keepAlive);
}
