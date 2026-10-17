/**
 * GitHub Actions status of the base branch (#1562) — the pure half.
 *
 * `arch-gate` and `security-scan` sat red on master for 13 and 10 days because nothing read the CI
 * result: the board's own gates and sweeps run elsewhere. This module turns `gh run list --json`
 * output into a per-workflow verdict and renders it as the three things the board shows (console
 * ATTENTION line, delivery chip, heal-ticket text). It decides; `services/ci-status.service.ts`
 * acts (runs `gh`, files tickets). No clock, no I/O.
 *
 * Only a workflow whose latest COMPLETED run failed is red; in-flight, cancelled and skipped runs
 * say nothing and are stepped over. A red is `sustained` once it spans more than one run — a single
 * red run is often a flake or the push that is about to be fixed, so it is reported but does not
 * file a ticket.
 */

/** The fields of `gh run list --json` this module reads. */
export const GH_RUN_LIST_FIELDS = "databaseId,workflowName,status,conclusion,headSha,url,createdAt,event";

export interface GhRun {
  databaseId?: number;
  workflowName: string;
  status: string;
  conclusion: string | null;
  headSha: string;
  url: string;
  createdAt: string;
  event?: string;
}

export type WorkflowCiVerdict = "green" | "red" | "pending";

export interface WorkflowCiState {
  workflow: string;
  verdict: WorkflowCiVerdict;
  /** Latest completed run (or the in-flight one when nothing has completed yet). */
  latest: GhRun;
  /** Consecutive failed completed runs, newest first; 0 unless red. */
  redRuns: number;
  /** `createdAt` of the oldest run in the red streak. */
  redSince: string | null;
  /** Red across more than one run: the threshold for a heal ticket and an ATTENTION line. */
  sustained: boolean;
}

const FAILING = new Set(["failure", "timed_out", "startup_failure"]);
const PASSING = new Set(["success"]);

/** Parse `gh run list --json` stdout into runs; `null` when it is not the expected array. */
export function parseGhRunList(stdout: string): GhRun[] | null {
  let raw: unknown;
  try { raw = JSON.parse(stdout); } catch { return null; }
  if (!Array.isArray(raw)) return null;
  return raw
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && typeof (r as Record<string, unknown>).workflowName === "string")
    .map((r) => ({
      databaseId: typeof r.databaseId === "number" ? r.databaseId : undefined,
      workflowName: String(r.workflowName),
      status: String(r.status ?? ""),
      conclusion: r.conclusion ? String(r.conclusion) : null,
      headSha: String(r.headSha ?? ""),
      url: String(r.url ?? ""),
      createdAt: String(r.createdAt ?? ""),
      event: r.event ? String(r.event) : undefined,
    }));
}

/**
 * Per-workflow verdicts from a run list (any order; sorted newest-first here).
 *
 * `required` is the project's configured workflow list; empty/absent means the default — every
 * workflow that ran on a push to the branch (the caller lists with `--event push`, and `event` is
 * re-checked here when present).
 */
export function summarizeWorkflows(runs: readonly GhRun[], required: readonly string[] = []): WorkflowCiState[] {
  const wanted = new Set(required.map((w) => w.trim().toLowerCase()).filter(Boolean));
  const byWorkflow = new Map<string, GhRun[]>();
  for (const run of runs) {
    if (run.event && run.event !== "push") continue;
    if (wanted.size > 0 && !wanted.has(run.workflowName.toLowerCase())) continue;
    const list = byWorkflow.get(run.workflowName) ?? [];
    list.push(run);
    byWorkflow.set(run.workflowName, list);
  }

  const out: WorkflowCiState[] = [];
  for (const [workflow, list] of byWorkflow) {
    list.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const decisive = list.filter((r) => r.status === "completed" && r.conclusion !== null && (PASSING.has(r.conclusion) || FAILING.has(r.conclusion)));
    if (decisive.length === 0) {
      out.push({ workflow, verdict: "pending", latest: list[0], redRuns: 0, redSince: null, sustained: false });
      continue;
    }
    if (PASSING.has(decisive[0].conclusion!)) {
      out.push({ workflow, verdict: "green", latest: decisive[0], redRuns: 0, redSince: null, sustained: false });
      continue;
    }
    let streak = 0;
    for (const r of decisive) {
      if (!FAILING.has(r.conclusion!)) break;
      streak++;
    }
    out.push({ workflow, verdict: "red", latest: decisive[0], redRuns: streak, redSince: decisive[streak - 1].createdAt || null, sustained: streak > 1 });
  }
  return out.sort((a, b) => a.workflow.localeCompare(b.workflow));
}

/** Parse the project's `ci_required_workflows_<id>` CSV. */
export function parseRequiredWorkflows(raw: string | null | undefined): string[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "an unknown date";
}

/** "CI red: arch-gate since 2026-10-04, run https://…" — the delivery chip and the ATTENTION line. */
export function formatCiRed(state: WorkflowCiState): string {
  return `CI red: ${state.workflow} since ${day(state.redSince)}, run ${state.latest.url}`;
}

/** The sustained-red states, in the order they are shown. */
export function sustainedRed(states: readonly WorkflowCiState[]): WorkflowCiState[] {
  return states.filter((s) => s.verdict === "red" && s.sustained);
}

/** What the board keeps per project and the console/delivery view read. */
export interface CiSnapshot {
  branch: string;
  checkedAt: string;
  /** Sustained-red workflows only; empty = nothing to say. */
  red: Array<{ workflow: string; since: string | null; runUrl: string; sha: string; runs: number; text: string }>;
}

export function toCiSnapshot(branch: string, states: readonly WorkflowCiState[], checkedAt: string): CiSnapshot {
  return {
    branch,
    checkedAt,
    red: sustainedRed(states).map((s) => ({ workflow: s.workflow, since: s.redSince, runUrl: s.latest.url, sha: s.latest.headSha, runs: s.redRuns, text: formatCiRed(s) })),
  };
}

// --- the failing job/step, from `gh run view <id> --json jobs` ---------------------------------------

export interface FailedJob { job: string; steps: string[] }

/** Jobs (and their failed steps) that did not pass, from `gh run view --json jobs` stdout. */
export function parseFailedJobs(stdout: string): FailedJob[] {
  let raw: unknown;
  try { raw = JSON.parse(stdout); } catch { return []; }
  const jobs = (raw as { jobs?: unknown })?.jobs;
  if (!Array.isArray(jobs)) return [];
  const out: FailedJob[] = [];
  for (const j of jobs as Array<Record<string, unknown>>) {
    if (!FAILING.has(String(j.conclusion ?? ""))) continue;
    const steps = Array.isArray(j.steps)
      ? (j.steps as Array<Record<string, unknown>>).filter((s) => FAILING.has(String(s.conclusion ?? ""))).map((s) => String(s.name ?? "?"))
      : [];
    out.push({ job: String(j.name ?? "?"), steps });
  }
  return out;
}

// --- the heal ticket ------------------------------------------------------------------------------

/** Namespace of the CI heal ticket's `external_key`; deliberately NOT the base-health prefix, so a green sweep never closes it. */
export const CI_HEAL_KEY_PREFIX = "ci-heal:";

/** One OPEN ticket per project and workflow. */
export function ciHealExternalKey(projectId: string, workflow: string): string {
  return `${CI_HEAL_KEY_PREFIX}${projectId}:${workflow}`;
}

export function ciHealKeyScanPrefix(projectId: string): string {
  return `${CI_HEAL_KEY_PREFIX}${projectId}:`;
}

export function ciHealTitle(branch: string, workflow: string): string {
  return `heal: CI workflow '${workflow}' is red on '${branch}'`;
}

export function ciHealBody(branch: string, state: WorkflowCiState, failed: readonly FailedJob[]): string {
  const lines = [
    `GitHub Actions workflow \`${state.workflow}\` has failed on \`${branch}\` for ${state.redRuns} consecutive run(s).`,
    ``,
    `- Red since: ${state.redSince ?? "unknown"}`,
    `- Latest failing run: ${state.latest.url}`,
    `- Head sha of that run: \`${state.latest.headSha}\``,
    ``,
    `## Failing job / step`,
    ``,
    ...(failed.length > 0
      ? failed.map((f) => `- \`${f.job}\`${f.steps.length > 0 ? ` → step${f.steps.length > 1 ? "s" : ""} ${f.steps.map((s) => `\`${s}\``).join(", ")}` : ""}`)
      : [`_The job list could not be read (\`gh run view\` unavailable); open the run above._`]),
    ``,
    `---`,
    ``,
    `Filed by the board's CI watch (#1562): the board's own gates run elsewhere and never read GitHub's`,
    `result. Fix the workflow (or the code it rejects) on the base branch. The watch refreshes this`,
    `ticket while the workflow stays red and closes it when the workflow is green again.`,
  ];
  return lines.join("\n");
}
