import type { BoardStatusIssue } from "@agentic-kanban/shared";
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
  /** Worker-placed chains: `typecheck 12/340`. Host chains do not report a stage. */
  stage?: string;
  position?: number;
  waitReason?: string;
}
export interface ConsoleBaseHealth { outcome: string; sha: string; createdAt: string; failedSuites: string[] }
export interface ConsoleMergeHold { reason: string; held: number[] }
export interface ConsoleRc { branch: string; sha: string | null; state: string; updatedAt: string | null }
export interface ConsoleConnectCode { codeHint: string; status: string; steps: Array<{ step: string; status: string }> }

export type ConsoleExtrasPayload = Partial<ConsoleExtras> & { unpromotedMerges?: number | null };

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

export function buildChains(extras: ConsoleExtrasPayload | null | undefined, issues: BoardStatusIssue[], workerJobs: Array<{ worker: string; job: string }>): ConsoleChain[] {
  const out: ConsoleChain[] = (extras?.chains ?? []).map((c) => ({
    kind: chainKindOf(c.label), ref: chainRefOf(c.label, issues), where: "host", state: c.state, ageMs: c.ageMs,
    ...(c.position != null ? { position: c.position } : {}), ...(c.waitReason ? { waitReason: c.waitReason } : {}),
  }));
  for (const j of workerJobs) {
    const [kind = "verify", sha = "", ...rest] = j.job.split(" ");
    out.push({ kind: kind.replace(/-/g, " "), ref: sha, where: j.worker, state: "running", ageMs: 0, stage: rest.join(" ") });
  }
  return out;
}

/** Issues that sit In Progress/In Review with nothing running, queued or waiting to merge. */
export function strandedIssues(issues: BoardStatusIssue[], chains: ConsoleChain[], workerTicketNumbers: Set<number>): number[] {
  const inChain = new Set(chains.map((c) => c.ref));
  return issues
    .filter((i) => i.issueNumber != null && (i.statusName === "In Progress" || i.statusName === "In Review"))
    .filter((i) => i.session?.status !== "running" && !i.remoteUnlanded && !i.attention && i.mergeState?.bucket !== "pending_merge")
    .filter((i) => !workerTicketNumbers.has(i.issueNumber!) && !inChain.has(`#${i.issueNumber}`))
    .map((i) => i.issueNumber!);
}

/** Fold the extras payload into the model: chains, base verdict, holds, rc, placement, stalled/stranded ATTENTION. */
export function applyConsoleExtras(model: ConsoleModel, p: ConsolePayloads): void {
  const extras = p.extras ?? null;
  const issues = p.status.issues;
  const workerJobs = model.workers.flatMap((w) => (w.verifyJobs ?? []).map((job) => ({ worker: w.name, job })));
  model.chains = buildChains(extras, issues, workerJobs);
  model.placement = extras?.placement ?? null;
  model.rc = extras?.rc ? { branch: extras.rc.branch, sha: extras.rc.sha, state: extras.rc.state, updatedAt: extras.rc.updatedAt } : null;
  model.unpromoted = p.host?.unpromotedMerges ?? null;
  model.baseHealth = extras?.baseHealth
    ? { outcome: extras.baseHealth.outcome, sha: extras.baseHealth.sha, createdAt: extras.baseHealth.createdAt, failedSuites: extras.baseHealth.failedSuites }
    : null;
  model.connectCodes = (extras?.connectCodes ?? []).map((c) => ({ codeHint: c.codeHint, status: c.status, steps: c.progress.map((s) => ({ step: s.step, status: s.status })) }));

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
  for (const n of strandedIssues(issues, model.chains, workerNumbers)) {
    if (named.has(n)) continue;
    const st = issues.find((i) => i.issueNumber === n)!.statusName;
    model.attention.push({ level: "yellow", text: `#${n} ${st}: no running session or queued chain` });
  }
}
