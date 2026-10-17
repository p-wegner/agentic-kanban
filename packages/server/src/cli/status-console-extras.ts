import type { BoardStatusIssue } from "@agentic-kanban/shared";
import { isInFlightStatusName } from "@agentic-kanban/shared/lib/status-view";
import type { ConsoleExtras } from "../services/console-extras.service.js";
import type { ConsoleModel, ConsolePayloads } from "./status-console-model.js";

// #1449: the console's operator-lookup data (verify chains, base verdict, rc, placement, stalls,
// stranded work), turned from the extras payload into plain model pieces. Pure — no clock, no I/O.

export interface ConsoleChain {
  kind: string;
  /** Ticket number (`#1431`) or branch/label the chain is for. */
  ref: string;
  where: string;
  state: "running" | "queued";
  ageMs: number;
  /** Worker-placed: `(full) typecheck 12/340`; host: setup/arch/typecheck/tests once the gate reports it. */
  stage?: string;
  /** #1462: vitest files finished / expected, when the runner knows. */
  filesDone?: number;
  filesTotal?: number;
  position?: number;
  waitReason?: string;
  /** #1497: the fleet worker the chain's script runs on (it holds no host slot). */
  worker?: string;
}
export interface ConsoleBaseHealth { outcome: string; sha: string; createdAt: string; failedSuites: string[] }
export interface ConsoleMergeHold { reason: string; held: number[] }
export interface ConsoleRc { branch: string; sha: string | null; state: string; updatedAt: string | null }
export interface ConsoleConnectCode { codeHint: string; status: string; steps: Array<{ step: string; status: string }> }

export type ConsoleExtrasPayload = Partial<ConsoleExtras> & { unpromotedMerges?: number | null; profileAttention?: string[] };

/** What a semaphore label says the chain is — the labels are free text written at each call site. */
export function chainKindOf(label: string): string {
  if (/implement-exit/i.test(label)) return "implement-exit check";
  if (/review-exit/i.test(label)) return "review-exit check";
  if (/E2E smoke/i.test(label)) return "e2e smoke";
  if (/base[- ]?(branch|health)|probe/i.test(label)) return "base-health probe";
  if (/rc[- ]sweep|release candidate/i.test(label)) return "rc sweep";
  if (/train/i.test(label)) return "train gate";
  return "workspace gate";
}

/** The ticket a label names via its workspace id (or `#N` text), else the label tail. */
export function chainRefOf(label: string, issues: BoardStatusIssue[]): string {
  const hash = /#(\d+)/.exec(label);
  if (hash) return `#${hash[1]}`;
  for (const i of issues) {
    if (i.workspace?.id && label.includes(i.workspace.id)) return i.issueNumber != null ? `#${i.issueNumber}` : i.workspace.branch;
  }
  const train = /train[/\s-]*(\S+)/i.exec(label);
  return train ? `train ${train[1]}` : label.replace(/^.*\bfor\s+/i, "").slice(0, 28);
}

export function buildChains(extras: ConsoleExtrasPayload | null | undefined, issues: BoardStatusIssue[], workerJobs: Array<{ worker: string; job: string; ageMs?: number }>): ConsoleChain[] {
  const out: ConsoleChain[] = (extras?.chains ?? []).map((c) => ({
    kind: chainKindOf(c.label), ref: chainRefOf(c.label, issues), where: c.worker ?? "host", state: c.state, ageMs: c.ageMs,
    ...(c.stage ? { stage: c.stage } : {}), ...(c.filesDone != null ? { filesDone: c.filesDone } : {}), ...(c.filesTotal != null ? { filesTotal: c.filesTotal } : {}),
    ...(c.position != null ? { position: c.position } : {}), ...(c.waitReason ? { waitReason: c.waitReason } : {}),
  }));
  for (const j of workerJobs) {
    const [kind = "verify", sha = "", ...rest] = j.job.split(" ");
    out.push({ kind: kind.replace(/-/g, " "), ref: sha, where: j.worker, state: "running", ageMs: j.ageMs ?? 0, stage: rest.join(" ") });
  }
  return out;
}

const LIVE_TRAIN_STATES = new Set(["assembling", "gating", "landing"]);

/**
 * #1566: tickets a merge train or its batching window is driving — members of an assembling/gating
 * train, and ready tickets waiting in the window for it to depart. These have a driver even though
 * they show no session or chain of their own.
 */
export function trainDrivenIssueNumbers(p: Pick<ConsolePayloads, "status" | "trains" | "window">): Set<number> {
  const out = new Set<number>();
  const byWorkspace = new Map<string, number>();
  for (const i of p.status.issues) if (i.workspace?.id && i.issueNumber != null) byWorkspace.set(i.workspace.id, i.issueNumber);
  for (const t of p.trains?.trains ?? []) {
    if (!LIVE_TRAIN_STATES.has(t.state)) continue;
    let ids: unknown[] = [];
    try { ids = JSON.parse(t.memberWorkspaceIds) as unknown[]; } catch { ids = []; }
    for (const id of ids) { const n = byWorkspace.get(String(id)); if (n != null) out.add(n); }
  }
  for (const m of p.window?.window?.pending ?? []) {
    const n = m.issueNumber ?? byWorkspace.get(m.workspaceId);
    if (n != null) out.add(n);
  }
  return out;
}

/** The one "has a driver" predicate: running session, remote work, pending merge, chain, worker, train or window. */
export function hasDriver(i: BoardStatusIssue, chains: ConsoleChain[], workerTicketNumbers: Set<number>, trainDriven: Set<number>): boolean {
  if (i.issueNumber == null) return true;
  if (i.session?.status === "running" || i.remoteUnlanded || i.attention || i.mergeState?.bucket === "pending_merge") return true;
  return workerTicketNumbers.has(i.issueNumber) || trainDriven.has(i.issueNumber) || chains.some((c) => c.ref === `#${i.issueNumber}`);
}

/** Issues that sit In Progress/In Review with nothing running, queued, waiting to merge or on a train. */
export function strandedIssues(issues: BoardStatusIssue[], chains: ConsoleChain[], workerTicketNumbers: Set<number>, trainDriven: Set<number> = new Set()): number[] {
  return issues
    .filter((i) => i.issueNumber != null && isInFlightStatusName(i.statusName))
    .filter((i) => !hasDriver(i, chains, workerTicketNumbers, trainDriven))
    .map((i) => i.issueNumber!);
}

/** Fold the extras payload into the model: chains, base verdict, holds, rc, placement, stalled/stranded ATTENTION. */
export function applyConsoleExtras(model: ConsoleModel, p: ConsolePayloads): void {
  const extras = p.extras ?? null;
  const issues = p.status.issues;
  const workerJobs = model.workers.flatMap((w) => (w.verifyJobs ?? []).map((job, i) => {
    const at = w.verifyJobStartedAt?.[i];
    return { worker: w.name, job, ageMs: at ? Math.max(0, p.nowMs - new Date(at).getTime()) : 0 };
  }));
  model.chains = buildChains(extras, issues, workerJobs);
  model.placement = extras?.placement ?? null;
  model.rc = extras?.rc ? { branch: extras.rc.branch, sha: extras.rc.sha, state: extras.rc.state, updatedAt: extras.rc.updatedAt } : null;
  model.unpromoted = p.host?.unpromotedMerges ?? null;
  model.baseHealth = extras?.baseHealth
    ? { outcome: extras.baseHealth.outcome, sha: extras.baseHealth.sha, createdAt: extras.baseHealth.createdAt, failedSuites: extras.baseHealth.failedSuites }
    : null;
  model.connectCodes = (extras?.connectCodes ?? []).map((c) => ({ codeHint: c.codeHint, status: c.status, steps: c.progress.map((s) => ({ step: s.step, status: s.status })) }));

  for (const text of extras?.profileAttention ?? []) model.attention.push({ level: "yellow", text }); // #1565

  const verdict = p.window?.window?.lastVerdict;
  if (verdict && !verdict.release && verdict.reason !== "accumulating") {
    const held = (p.window?.window?.pending ?? []).map((m) => m.issueNumber ?? 0).filter(Boolean);
    model.mergeHold = { reason: verdict.reason, held };
    if (verdict.reason === "base_red" || verdict.reason === "breaker_paused") {
      const sha = model.baseHealth?.sha.slice(0, 8);
      model.attention.push({ level: "red", text: `merges held: ${verdict.reason}${sha ? ` (master ${sha})` : ""}, holding ${held.length ? held.map((n) => `#${n}`).join(" ") : "nothing yet"}` });
    }
  } else model.mergeHold = null;

  const named = new Set<number>();
  for (const s of extras?.stalls ?? []) {
    const open = issues.find((i) => i.issueNumber === s.issueNumber);
    if (s.issueNumber != null && (!open || open.session?.status === "running")) continue; // closed, or relaunched since
    if (s.issueNumber != null) named.add(s.issueNumber);
    model.attention.push({ level: "red", text: `${s.issueNumber != null ? `#${s.issueNumber} ` : ""}${s.text}` });
  }
  const workerNumbers = new Set(model.workers.flatMap((w) => w.tickets.map((t) => t.issueNumber).filter((n): n is number => n != null)));
  for (const n of strandedIssues(issues, model.chains, workerNumbers, trainDrivenIssueNumbers(p))) {
    if (named.has(n)) continue;
    const st = issues.find((i) => i.issueNumber === n)!.statusName;
    model.attention.push({ level: "yellow", text: `#${n} ${st}: no running session or queued chain` });
  }
}
