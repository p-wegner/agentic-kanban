/**
 * The CI half of a promotion (#1562): what GitHub Actions says about the sha being promoted.
 *
 * `arch-gate` and `security-scan` sat red on master for 10+ days because nothing read the CI
 * result. The board now watches the base branch (`packages/server/src/lib/ci-status.ts`); this is
 * the promotion's own read, kept dependency-free like the rest of `scripts/` (the server's TS
 * cannot be imported here, so the small run-selection logic is mirrored — the formats are pinned by
 * `promote-ci.test.ts`).
 *
 * `evaluatePromoteCi` is pure. `readCiForSha` is the one place that spawns `gh`, and it SKIPS
 * cleanly (never refuses) when `gh` is missing, unauthenticated or the repo is not on GitHub:
 * a promotion must not be blocked by the absence of the thing that would have warned about it.
 */
import { execFileSync } from "node:child_process";

export const CI_RUN_FIELDS = "databaseId,workflowName,status,conclusion,headSha,url,createdAt,event";
const FAILING = new Set(["failure", "timed_out", "startup_failure"]);

/** CSV (`arch-gate, security-scan`) to a clean list; empty = every workflow that ran on push. */
export function parseRequiredWorkflows(raw) {
  return String(raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Verdict over the runs GitHub recorded for ONE sha. Per workflow the newest run wins (a re-run
 * that went green supersedes the red one). Only `push` runs count unless the run names no event.
 *
 * @returns {{ ok: boolean, red: Array<{workflow:string,url:string}>, pending: string[], green: string[], detail: string }}
 */
export function evaluatePromoteCi(runs, required = []) {
  const wanted = new Set(required.map((w) => String(w).toLowerCase()));
  const newest = new Map();
  for (const run of runs ?? []) {
    if (run?.event && run.event !== "push") continue;
    const name = String(run?.workflowName ?? "");
    if (!name || (wanted.size > 0 && !wanted.has(name.toLowerCase()))) continue;
    const prev = newest.get(name);
    if (!prev || Date.parse(run.createdAt) > Date.parse(prev.createdAt)) newest.set(name, run);
  }
  const red = [];
  const pending = [];
  const green = [];
  for (const [workflow, run] of newest) {
    if (run.status !== "completed") pending.push(workflow);
    else if (FAILING.has(String(run.conclusion))) red.push({ workflow, url: String(run.url ?? "") });
    else if (run.conclusion === "success") green.push(workflow);
  }
  const parts = [];
  if (red.length) parts.push(`RED: ${red.map((r) => `${r.workflow} (${r.url})`).join(", ")}`);
  if (pending.length) parts.push(`running: ${pending.join(", ")}`);
  if (green.length) parts.push(`green: ${green.join(", ")}`);
  return {
    ok: red.length === 0,
    red,
    pending,
    green,
    detail: parts.length ? parts.join("; ") : "no GitHub Actions run recorded for this sha",
  };
}

/** The refusal text for a red verdict. */
export function formatCiRefusal(verdict, sha) {
  return `GitHub CI is RED on ${sha}: ${verdict.red.map((r) => `${r.workflow} (${r.url})`).join(", ")}. Fix it, or promote anyway with --ignore-ci.`;
}

/**
 * `gh run list --commit <sha>` in `cwd`. Resolves `{ available: false, reason }` when gh cannot
 * answer; never throws.
 */
export function readCiForSha(sha, { cwd, exec = execFileSync } = {}) {
  try {
    const out = exec("gh", ["run", "list", "--commit", sha, "--limit", "50", "--json", CI_RUN_FIELDS], {
      cwd, encoding: "utf8", timeout: 30_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const runs = JSON.parse(String(out));
    if (!Array.isArray(runs)) return { available: false, reason: "gh run list did not return a JSON array" };
    return { available: true, runs };
  } catch (err) {
    const first = String(err?.stderr || err?.message || err).trim().split("\n")[0];
    return { available: false, reason: `gh unavailable: ${first}` };
  }
}
