// What `status --watch` (#1449) needs beyond the board status/worker/train reads: running verify
// chains, base-branch verdict, rc state, verify placement and stalled sessions. One cheap read
// the console polls; every part degrades to null/empty on its own failure.
import type { RcCandidateSummary } from "@agentic-kanban/shared";
import type { Database } from "../db/index.js";
import { getLatestBaseBranchHealth, decodeFailedSuites } from "../repositories/base-branch-health.repository.js";
import { getPreference } from "../repositories/preferences.repository.js";
import { getProjectById } from "../repositories/project.repository.js";
import { listRecentEndedSessions } from "../repositories/console-stalls.repository.js";
import { currentRcCandidate, readRcState, resolveStableCheckoutFor, toRcCandidateSummary } from "./rc-state.js";
import { parseVerifyPlacement, parseVerifyWorkerAllowlist, verifyPlacementPrefKey, verifyWorkersPrefKey, type VerifyPlacement } from "./verify-placement.js";
import { getCiSnapshot } from "./ci-status.service.js";
import { describeCodeHealth, resolveProjectCodeHealth } from "./code-health.service.js";
import { getAllPreferencesCached } from "../repositories/preferences.repository.js";
import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
import { getConnectCodeStore } from "./worker-connect-code.service.js";
import { getPluginService } from "./plugin.service.js";
import type { PluginSyncHealth } from "./plugin-sync.service.js";
import { listVerifyChains, type VerifyChainSnapshotEntry } from "./verify-chain-semaphore.js";

export type ConsoleStallKind = "watchdog" | "no_worker" | "push_refused";
export interface ConsoleStall { issueNumber: number | null; kind: ConsoleStallKind; text: string; at: string | null }

export interface ConsoleExtras {
  chains: VerifyChainSnapshotEntry[];
  baseHealth: { outcome: string; sha: string; branch: string; createdAt: string; message: string | null; failedSuites: string[] } | null;
  rc: RcCandidateSummary | null;
  placement: { mode: VerifyPlacement; workers: string[] };
  stalls: ConsoleStall[];
  /** #1442: one-time connect codes still live, with their progress steps. */
  connectCodes: Array<{ codeHint: string; status: string; expiresAt: string; progress: Array<{ step: string; status: string; at: string }> }>;
  /** #1562: sustained-red GitHub workflows on the base branch ("CI red: arch-gate since …, run <url>"). */
  ciRed: string[];
  /** #1619: `code health: 7 soft breaches in 4 files, cleanup ticket at 10 (relaxed)` from the latest scan; null before any soft breach was recorded. */
  codeHealth: string | null;
  /** #1673/#1697: Jira-style sync health per enabled sync plugin of EVERY project, from stored run summaries (no provider calls). */
  syncHealth: PluginSyncHealth[];
}

const STALL_WINDOW_MS = 6 * 3600 * 1000;

/** Pure: the stall a session's stderr tail names, or null. Newest line wins. */
export function classifyStall(stderrTail: string[]): { kind: ConsoleStallKind; text: string } | null {
  for (const line of stderrTail) {
    const flat = line.replace(/\s+/g, " ").trim();
    if (/Agent hang watchdog/i.test(flat)) return { kind: "watchdog", text: flat.slice(0, 120) };
    if (/NO_AVAILABLE_WORKER/.test(flat)) return { kind: "no_worker", text: "launch failed: NO_AVAILABLE_WORKER" };
    const push = /(stale but clean rebase|rewritten history)/i.exec(flat);
    if (push) return { kind: "push_refused", text: `worker push refused: ${push[1]}${/(refs\/[^\s,;)]+)/.exec(flat) ? ` (${/(refs\/[^\s,;)]+)/.exec(flat)![1]})` : ""}` };
  }
  return null;
}

export async function buildConsoleExtras(projectId: string, database: Database, nowMs: number = Date.now()): Promise<ConsoleExtras> {
  const project = await getProjectById(projectId, database).catch(() => null);
  const health = await getLatestBaseBranchHealth(projectId, database).catch(() => null);
  const [placementRaw, workersRaw] = await Promise.all([
    getPreference(verifyPlacementPrefKey(projectId), database).catch(() => null),
    getPreference(verifyWorkersPrefKey(projectId), database).catch(() => null),
  ]);
  let rc: RcCandidateSummary | null = null;
  try { rc = project?.repoPath ? toRcCandidateSummary(currentRcCandidate(readRcState(resolveStableCheckoutFor(project.repoPath)))) : null; } catch { rc = null; }
  const ended = await listRecentEndedSessions(projectId, new Date(nowMs - STALL_WINDOW_MS).toISOString(), database).catch(() => []);
  const stalls: ConsoleStall[] = [];
  for (const s of ended) {
    const c = classifyStall(s.stderrTail);
    if (c) stalls.push({ issueNumber: s.issueNumber, kind: c.kind, text: c.text, at: s.endedAt });
  }
  let codeHealth: string | null = null;
  try {
    const prefMap = toPrefMap(await getAllPreferencesCached(database));
    const status = describeCodeHealth(await resolveProjectCodeHealth(projectId, prefMap), prefMap, projectId);
    codeHealth = status.openSoftBreaches > 0 ? status.line : null;
  } catch { codeHealth = null; }
  const syncHealth = await getPluginService(database).listSyncHealth().catch(() => []);
  return {
    codeHealth,
    syncHealth,
    chains: listVerifyChains(nowMs),
    baseHealth: health
      ? { outcome: health.outcome, sha: health.sha, branch: health.branch, createdAt: health.createdAt, message: health.message ?? null, failedSuites: decodeFailedSuites(health.failedSuites) }
      : null,
    rc,
    placement: { mode: parseVerifyPlacement(placementRaw), workers: [...parseVerifyWorkerAllowlist(workersRaw)] },
    stalls,
    ciRed: (getCiSnapshot(projectId)?.red ?? []).map((r) => r.text),
    connectCodes: getConnectCodeStore().listLive(nowMs).map((v) => ({
      codeHint: v.codeHint, status: v.status, expiresAt: v.expiresAt,
      progress: v.progress.map((p) => ({ step: p.step, status: p.status, at: p.at })),
    })),
  };
}
