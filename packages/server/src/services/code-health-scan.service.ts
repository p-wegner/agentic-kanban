import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { getPreference, setPreference } from "../repositories/preferences.repository.js";
import type { SoftBreach } from "../lib/code-health.js";
import { recordCodeHealth } from "./code-health.service.js";
import { runUnderVerifyChainSemaphore } from "./verify-chain-semaphore.js";

/**
 * The caller of the code-health report (#1619, decision 021). The gate script measures, the
 * ledger records; this is the missing step between them. It OBSERVES the base branch tip instead
 * of hooking each landing path (train, single merge, operator hand-merge): a new tip sha is a
 * landing by definition, and a sha already scanned is never scanned twice, so a re-observed
 * landing cannot double-count. A project with no landings is re-scanned once a day so the
 * "N days" trigger still fires. A failure logs one `[code-health-scan]` line, stores nothing, and
 * the next tick retries; nothing here throws into a caller.
 */

export const codeHealthScanPref = projectPref("code_health_scan");
export const CODE_HEALTH_SCAN_DAILY_MS = 24 * 3600 * 1000;
const SCAN_TIMEOUT_MS = 5 * 60 * 1000;

export interface CodeHealthScanState { sha: string; at: string }

export type CodeHealthScanOutcome = "scanned" | "unchanged" | "skipped" | "failed";

export interface ScanCodeHealthInput {
  projectId: string;
  repoPath: string;
  defaultBranch: string;
  nowMs?: number;
}

export interface CodeHealthScanDeps {
  database?: Database;
  /** The base branch tip, and whether the checkout actually sits on it. */
  resolveTip?: (repoPath: string, branch: string) => Promise<{ tip: string; head: string }>;
  /** Run the gate script's `--report` mode and return its soft breaches. */
  runScan?: (repoPath: string) => Promise<SoftBreach[] | null>;
  record?: typeof recordCodeHealth;
}

export function parseScanState(raw: string | null | undefined): CodeHealthScanState | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<CodeHealthScanState>;
    return typeof v.sha === "string" && typeof v.at === "string" ? { sha: v.sha, at: v.at } : null;
  } catch { return null; }
}

/** Pure: scan when the tip moved since the last successful scan, or the last scan is a day old. */
export function isScanDue(state: CodeHealthScanState | null, tip: string, nowMs: number): boolean {
  if (!state || state.sha !== tip) return true;
  const at = Date.parse(state.at);
  return !Number.isFinite(at) || nowMs - at >= CODE_HEALTH_SCAN_DAILY_MS;
}

async function defaultResolveTip(repoPath: string, branch: string): Promise<{ tip: string; head: string }> {
  const [tip, head] = await Promise.all([
    gitExec(["rev-parse", branch], { cwd: repoPath }),
    gitExec(["rev-parse", "HEAD"], { cwd: repoPath }),
  ]);
  if (tip.error || !tip.stdout.trim()) throw new Error(`cannot resolve ${branch}: ${tip.stderr || "empty"}`);
  return { tip: tip.stdout.trim(), head: head.stdout.trim() };
}

/** `node scripts/check-god-modules.mjs --report <tmp>.json` on a host verify slot. Null = no script here. */
async function defaultRunScan(repoPath: string): Promise<SoftBreach[] | null> {
  const script = join(repoPath, "scripts", "check-god-modules.mjs");
  if (!existsSync(script)) return null;
  const dir = await mkdtemp(join(tmpdir(), "code-health-"));
  const out = join(dir, "report.json");
  try {
    await runUnderVerifyChainSemaphore(
      () => new Promise<void>((resolve) => {
        // A HARD breach exits non-zero but still writes the report, so the exit code is ignored.
        execFile(process.execPath, [script, "--report", out], { cwd: repoPath, windowsHide: true, timeout: SCAN_TIMEOUT_MS }, () => resolve());
      }),
      `code-health scan ${repoPath}`,
    );
    const parsed = JSON.parse(await readFile(out, "utf8")) as { softBreaches?: SoftBreach[] };
    if (!Array.isArray(parsed.softBreaches)) throw new Error("report has no softBreaches");
    return parsed.softBreaches;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** One project, one decision. Never throws. */
export async function scanCodeHealthOnce(input: ScanCodeHealthInput, deps: CodeHealthScanDeps = {}): Promise<CodeHealthScanOutcome> {
  const database = deps.database ?? db;
  const nowMs = input.nowMs ?? Date.now();
  try {
    const { tip, head } = await (deps.resolveTip ?? defaultResolveTip)(input.repoPath, input.defaultBranch);
    const state = parseScanState(await getPreference(codeHealthScanPref.key(input.projectId), database));
    if (!isScanDue(state, tip, nowMs)) return "unchanged";
    if (head !== tip) return "skipped"; // the checkout is not on the landed tip; scan it once it is
    const breaches = await (deps.runScan ?? defaultRunScan)(input.repoPath);
    if (breaches === null) return "skipped"; // not a project that carries the gate script
    await (deps.record ?? recordCodeHealth)({ projectId: input.projectId, breaches, ref: tip, now: new Date(nowMs).toISOString() }, database);
    await setPreference(codeHealthScanPref.key(input.projectId), JSON.stringify({ sha: tip, at: new Date(nowMs).toISOString() }), database);
    return "scanned";
  } catch (err) {
    console.warn(`[code-health-scan] project ${input.projectId}: scan failed, will retry on the next landing: ${errorMessage(err)}`);
    return "failed";
  }
}
