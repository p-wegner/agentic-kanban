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

type Counts = NonNullable<PluginSyncRunSummary["counts"]>;
type SummaryIssue = NonNullable<PluginSyncRunSummary["issues"]>[number];
type SummaryConflict = NonNullable<PluginSyncRunSummary["conflicts"]>[number];
type LinkFn = (key: string, explicit?: unknown) => string | undefined;

/** A dry run wrote nothing, so its writes are planned, never applied/created/updated/deleted (#1638). */
const DRY_RUN_RENAMES: Array<[keyof Counts, keyof Counts]> = [
  ["created", "wouldCreate"], ["updated", "wouldUpdate"], ["deleted", "wouldDelete"], ["applied", "planned"],
];

function buildCounts(rec: Rec): Counts {
  const counts: Counts = isRec(rec.counts) ? { ...rec.counts } : {};
  for (const k of ["created", "updated", "skipped", "conflicted"] as const) {
    const n = num(rec[k]);
    if (n !== undefined) counts[k] = n;
  }
  if (Array.isArray(rec.deleted)) counts.deleted = rec.deleted.length;
  const applied = num(rec.appliedCount);
  const failed = num(rec.failedCount);
  if (applied !== undefined) counts.applied = applied;
  if (failed !== undefined) counts.failed = failed;
  if (Array.isArray(rec.reportedOutOfScope)) counts.outOfScope = rec.reportedOutOfScope.length;
  if (rec.dryRun !== true) return counts;
  for (const [from, to] of DRY_RUN_RENAMES) {
    if (counts[from] === undefined) continue;
    counts[to] = counts[from];
    delete counts[from];
  }
  return counts;
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((c): c is string => typeof c === "string") : []);

/** The status text of a non-conflict `details` row: action, what changed / why, link notes, drift. */
function detailStatus(d: Rec): string {
  // #1709: board-to-jira drift is not a plain skip: say which fields Jira differs on.
  const drift = isRec(d.jiraDiffers) ? Object.keys(d.jiraDiffers) : [];
  const driftNote = drift.length ? `: Jira differs on ${drift.join(", ")}; the next push restores the board value` : "";
  // #1720: carry the plugin's own words (what changed / why it was refused) into the status.
  const what = (Array.isArray(d.changes) ? strList(d.changes).join("; ") : str(d.changes)) || str(d.reason);
  const linkNotes = strList(d.linkNotes);
  const text = what || linkNotes.length ? `: ${[what, ...linkNotes].filter(Boolean).join("; ")}` : "";
  return `${str(d.action) ?? ""}${text}${driftNote}`;
}

function collectDetails(
  rec: Rec, link: LinkFn, wouldBe: (s: string | undefined) => string | undefined,
  issues: SummaryIssue[], conflicts: SummaryConflict[],
): void {
  for (const d of recs(rec.details)) {
    const key = str(d.key);
    if (!key) continue;
    const localIssueNumber = num(d.localIssueNumber);
    if (d.action === "conflict") {
      conflicts.push({ externalKey: key, reason: str(d.reason) ?? "", externalUrl: link(key), localIssueNumber });
      continue;
    }
    issues.push({ externalKey: key, status: wouldBe(detailStatus(d) || undefined), externalUrl: link(key), localIssueNumber });
  }
}

function collectApplied(
  rec: Rec, link: LinkFn, wouldBe: (s: string | undefined) => string | undefined, issues: SummaryIssue[],
): void {
  for (const a of recs(rec.applied)) {
    const key = str(a.key);
    if (key) issues.push({ externalKey: key, status: wouldBe(str(a.change) ?? str(a.kind) ?? "applied"), externalUrl: link(key), localIssueNumber: num(a.localIssueNumber) });
  }
}

function collectGeneric(rec: Rec, link: LinkFn, issues: SummaryIssue[], conflicts: SummaryConflict[]): void {
  for (const i of recs(rec.issues)) {
    const key = str(i.externalKey);
    if (key) issues.push({ externalKey: key, externalUrl: link(key, i.externalUrl), localIssueNumber: num(i.localIssueNumber), status: str(i.status) });
  }
  for (const c of recs(rec.conflicts)) {
    const key = str(c.externalKey);
    if (key) conflicts.push({ externalKey: key, reason: String(c.reason ?? ""), externalUrl: link(key, c.externalUrl), localIssueNumber: num(c.localIssueNumber) });
  }
}

function collectFailures(rec: Rec, link: LinkFn): NonNullable<PluginSyncRunSummary["failures"]> {
  return recs(rec.failed)
    .map((f) => ({ externalKey: str(f.key) ?? "", reason: str(f.reason) ?? "", kind: str(f.kind), localIssueNumber: num(f.localIssueNumber) }))
    .filter((f) => f.externalKey || f.reason)
    .map((f) => ({ ...f, externalUrl: f.externalKey ? link(f.externalKey) : undefined }));
}

/** `{ siteUrl }` turns a Jira key into its browse link; absent -> no link. */
export function parseRunSummary(stdout: string, opts: { siteUrl?: string } = {}): PluginSyncRunSummary | undefined {
  const rec = parseRunOutput(stdout);
  if (!rec) return undefined;
  const site = opts.siteUrl?.trim().replace(/\/+$/, "");
  const link: LinkFn = (key, explicit) => str(explicit) ?? (site ? `${site}/browse/${key}` : undefined);
  const wouldBe = (s: string | undefined) => (rec.dryRun === true && s ? `would ${s}` : s);
  const summary: PluginSyncRunSummary = {};
  const step = str(rec.step);
  if (step) summary.step = step;
  const counts = buildCounts(rec);
  if (Object.keys(counts).length) summary.counts = counts;
  const note = str(rec.droppedNote);
  if (note) summary.notes = [note];

  const issues: SummaryIssue[] = [];
  const conflicts: SummaryConflict[] = [];
  collectDetails(rec, link, wouldBe, issues, conflicts);
  collectApplied(rec, link, wouldBe, issues);
  collectGeneric(rec, link, issues, conflicts);
  // A generic `{issues: []}` is a statement ("none"), so keep the empty array when the script sent one.
  if (issues.length || Array.isArray(rec.issues)) summary.issues = issues;
  if (conflicts.length || Array.isArray(rec.conflicts)) summary.conflicts = conflicts;
  const failures = collectFailures(rec, link);
  if (failures.length) summary.failures = failures;
  return summary;
}

/**
 * A dry run must not create anything: an applied "create" that carries a new Jira key (a dry run
 * reports wouldApply and no key) means the plugin ignored the dry-run contract (#1634).
 */
export function dryRunContractBreach(stdout: string): string | undefined {
  const rec = parseRunOutput(stdout);
  if (!rec) return undefined;
  const created = recs(rec.applied).filter((a) => a.kind === "create" && str(a.key) && a.wouldApply !== true);
  if (created.length === 0) return undefined;
  return `dry-run contract breach: the plugin created ${created.map((a) => str(a.key)).join(", ")} during a dry run`;
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
