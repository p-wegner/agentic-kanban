#!/usr/bin/env node
// Warns (never blocks) when a commit/push on the base branch lands while a merge train is gating (#1607).
// Called from .githooks/pre-commit and .githooks/pre-push; `pnpm cli -- train status` prints the same line.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gitExecSync } from "./git-exec.mjs";

const LIVE_STATES = new Set(["gating", "landing"]);
const BASE_BRANCHES = new Set(["master", "main"]);

const pad = (n) => String(n).padStart(2, "0");

/** One warning line per live train, e.g. "train/2026-10-18-04 is gating since 14:05; a commit now moves its base". */
export function formatTrainWarnings(trains) {
  return trains
    .filter((t) => LIVE_STATES.has(t.state))
    .map((t) => {
      const started = new Date(t.startedAt);
      const since = Number.isNaN(started.getTime()) ? "?" : `${pad(started.getHours())}:${pad(started.getMinutes())}`;
      const label = t.label.startsWith("train/") ? t.label : `train/${t.label}`;
      return `${label} is ${t.state} since ${since}; a commit now moves its base`;
    });
}

const samePath = (a, b) => resolve(a).replace(/[\/]+$/, "").toLowerCase() === resolve(b).replace(/[\/]+$/, "").toLowerCase();

async function getJson(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function liveTrainWarnings(repoPath, { port, timeoutMs = 1500 } = {}) {
  const base = `http://127.0.0.1:${port ?? process.env.KANBAN_BOARD_SERVER_PORT ?? process.env.KANBAN_SERVER_PORT ?? process.env.PORT ?? 3001}/api`;
  const projects = await getJson(`${base}/projects`, timeoutMs);
  const project = (Array.isArray(projects) ? projects : []).find((p) => p.repoPath && samePath(p.repoPath, repoPath));
  if (!project) return [];
  const body = await getJson(`${base}/merge-queue/trains?projectId=${encodeURIComponent(project.id)}`, timeoutMs);
  return formatTrainWarnings(body.trains ?? []);
}

async function main() {
  try {
    const top = gitExecSync(["rev-parse", "--show-toplevel"]).trim();
    const branch = gitExecSync(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    if (!BASE_BRANCHES.has(branch)) return;
    for (const line of await liveTrainWarnings(top)) console.warn(`[train] warning: ${line}`);
  } catch {
    // Board down, slow or unreachable: a warning hook must never get in the way of a commit.
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await main();
