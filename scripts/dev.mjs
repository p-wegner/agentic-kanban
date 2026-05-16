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
  const match = branchName.match(/^feature\/(\d+)-/);
  return match ? parseInt(match[1], 10) : null;
}

function branchHash(branchName) {
  let hash = 0;
  for (let i = 0; i < branchName.length; i++) {
    hash = (hash * 31 + branchName.charCodeAt(i)) & 0xffff;
  }
  return (hash % 100) + 1;
}

const { isWorktree, branch } = detectWorktree();
let serverPort = DEFAULT_SERVER_PORT;
let clientPort = DEFAULT_CLIENT_PORT;

if (isWorktree && branch) {
  const issueNum = getIssueNumber(branch);
  const offset = issueNum !== null ? issueNum : branchHash(branch);
  serverPort = DEFAULT_SERVER_PORT + offset;
  clientPort = DEFAULT_CLIENT_PORT + offset;
  console.log(`[dev] Worktree detected (${branch}) — server:${serverPort} client:${clientPort}`);
} else {
  console.log(`[dev] Main checkout — server:${serverPort} client:${clientPort}`);
}

process.env.PORT = String(serverPort);
process.env.VITE_PORT = String(clientPort);
process.env.SERVER_PORT = String(serverPort);
process.env.KANBAN_SERVER_PORT = String(serverPort);
process.env.KANBAN_CLIENT_PORT = String(clientPort);

const child = spawn("npx", ["concurrently", "pnpm --filter server dev", "pnpm --filter client dev"], {
  stdio: "inherit",
  shell: true,
  env: process.env,
});

child.on("exit", (code) => process.exit(code ?? 0));
