import { extractModelJson } from "@agentic-kanban/shared/lib/model-json";
import type { PluginSyncRunSummary } from "@agentic-kanban/shared";

export type { PluginSyncRunSummary };

/**
 * The ONE run-summary contract between a plugin's pull/push command and the board (#1625), see
 * `PluginSyncRunSummary` in shared. `parseRunSummary` normalizes what jira-sync's scripts print
 * (pull: `{created, updated, skipped, conflicted, reportedOutOfScope, details}`, push:
 * `{total, appliedCount, failedCount, applied, failed}`) — and still honours the generic
 * `{counts, issues, conflicts}` shape.
 */

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => v != null && typeof v === "object" && !Array.isArray(v);
const recs = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter(isRec) : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function parseRunOutput(stdout: string): Rec | undefined {
  const text = stdout.trim();
  if (!text) return undefined;
  try {
    const raw = extractModelJson(text, { shape: "object", prefer: "last" });
    return isRec(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** `{ siteUrl }` turns a Jira key into its browse link; absent -> no link. */
export function parseRunSummary(stdout: string, opts: { siteUrl?: string } = {}): PluginSyncRunSummary | undefined {
  const rec = parseRunOutput(stdout);
  if (!rec) return undefined;
  const site = opts.siteUrl?.trim().replace(/\/+$/, "");
  const link = (key: string, explicit?: unknown) => str(explicit) ?? (site ? `${site}/browse/${key}` : undefined);
  const summary: PluginSyncRunSummary = {};
  const step = str(rec.step);
  if (step) summary.step = step;

  const counts: NonNullable<PluginSyncRunSummary["counts"]> = isRec(rec.counts) ? { ...rec.counts } : {};
  for (const k of ["created", "updated", "skipped", "conflicted"] as const) {
    const n = num(rec[k]);
    if (n !== undefined) counts[k] = n;
  }
  const applied = num(rec.appliedCount);
  const failed = num(rec.failedCount);
  if (applied !== undefined) counts.applied = applied;
  if (failed !== undefined) counts.failed = failed;
  if (Array.isArray(rec.reportedOutOfScope)) counts.outOfScope = rec.reportedOutOfScope.length;
  if (Object.keys(counts).length) summary.counts = counts;

  const issues: NonNullable<PluginSyncRunSummary["issues"]> = [];
  const conflicts: NonNullable<PluginSyncRunSummary["conflicts"]> = [];
  for (const d of recs(rec.details)) {
    const key = str(d.key);
    if (!key) continue;
    if (d.action === "conflict") conflicts.push({ externalKey: key, reason: str(d.reason) ?? "", externalUrl: link(key) });
    else issues.push({ externalKey: key, status: str(d.action), externalUrl: link(key) });
  }
  for (const a of recs(rec.applied)) {
    const key = str(a.key);
    if (key) issues.push({ externalKey: key, status: str(a.kind) ?? "applied", externalUrl: link(key) });
  }
  for (const i of recs(rec.issues)) {
    const key = str(i.externalKey);
    if (key) {
      issues.push({ externalKey: key, externalUrl: link(key, i.externalUrl), localIssueNumber: num(i.localIssueNumber), status: str(i.status) });
    }
  }
  for (const c of recs(rec.conflicts)) {
    const key = str(c.externalKey);
    if (key) conflicts.push({ externalKey: key, reason: String(c.reason ?? ""), externalUrl: link(key, c.externalUrl) });
  }
  // A generic `{issues: []}` is a statement ("none"), so keep the empty array when the script sent one.
  if (issues.length || Array.isArray(rec.issues)) summary.issues = issues;
  if (conflicts.length || Array.isArray(rec.conflicts)) summary.conflicts = conflicts;

  const failures = recs(rec.failed)
    .map((f) => ({ externalKey: str(f.key) ?? "", reason: str(f.reason) ?? "", kind: str(f.kind) }))
    .filter((f) => f.externalKey || f.reason)
    .map((f) => ({ ...f, externalUrl: f.externalKey ? link(f.externalKey) : undefined }));
  if (failures.length) summary.failures = failures;
  return summary;
}

/** The last lines of stderr, bounded, for a failure message. */
export function stderrTail(stderr: string, maxLines = 5, maxChars = 600): string {
  const lines = stderr.trim().split(/\r?\n/).filter(Boolean).slice(-maxLines).join("\n");
  return lines.length > maxChars ? lines.slice(-maxChars) : lines;
}

/**
 * Why a run failed, from what the script itself said: `{"ok":false,"step","reason"}` on stdout
 * first, then the stderr tail, then the bare exit code (#1625 â€” it used to be ONLY the code).
 */
export function describeRunFailure(
  result: { code: number | null; timedOut: boolean; stdout: string; stderr: string },
): string {
  if (result.timedOut) return "sync command timed out";
  const rec = parseRunOutput(result.stdout);
  const parts: string[] = [];
  const reason = rec && str(rec.reason);
  if (reason) {
    const step = str(rec?.step);
    parts.push(step ? `${step}: ${reason}` : reason);
  } else if (rec && num(rec.failedCount)) {
    const first = recs(rec.failed)[0];
    parts.push(`${rec.failedCount} push entr${rec.failedCount === 1 ? "y" : "ies"} failed${first && str(first.reason) ? ` (e.g. ${str(first.key) ?? "?"}: ${str(first.reason)})` : ""}`);
  }
  const tail = stderrTail(result.stderr);
  if (tail) parts.push(`stderr: ${tail}`);
  if (parts.length === 0) parts.push(`sync command exited with code ${result.code}`);
  return parts.join(" | ");
}
