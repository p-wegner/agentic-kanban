/**
 * Partial-work disclosure check (#1438): a cheap, agent-free exit check over a branch's commit
 * bodies.
 *
 * #1428 and #1430 each said in their own commit message that the acceptance was not implemented
 * ("Remote execution transport and gate wiring remain to be done", "setVerifyWorkerRunner is not
 * registered yet ... until #1428's runner lands"), and both still passed the implement-exit check,
 * the review and the pre-merge gate, because every one of those judges the code that IS there. The
 * root CLAUDE.md requires a disclosure channel for partial work (#691): a follow-up ticket naming
 * what remains. This is the board side of that rule: a commit that discloses unfinished work
 * without referencing an OPEN follow-up ticket withholds `readyForMerge`.
 *
 * The scan (`scanCommitsForDisclosure`) is pure; `checkPartialWorkDisclosure` reads the commits and
 * resolves the referenced tickets. Fail-open on a read error: this is a guard against a known
 * failure shape, not a gate that may strand finished work on a harness fault.
 */
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { execErrorMessage, execSucceeded } from "@agentic-kanban/shared/lib/exec-result";
import { isTerminalStatusName } from "@agentic-kanban/shared/lib/status-view";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { getIssuesByProject } from "../repositories/issue.repository.js";

/** One commit as the scan sees it. */
export interface DisclosureCommit {
  sha: string;
  subject: string;
  body: string;
}

/** Phrases by which a commit admits the work is unfinished. Case-insensitive. */
export const DISCLOSURE_PATTERNS: readonly RegExp[] = [
  /\bremain(?:s|ing)?\s+(?:to\s+be\s+)?(?:done|implemented|wired|built|written|added)\b/i,
  /\bnot\s+(?:yet\s+)?(?:registered|wired(?:\s+up)?|implemented|hooked\s+up|connected|landed|built)\b/i,
  /\b(?:registered|wired(?:\s+up)?|implemented|hooked\s+up|connected|landed|built)\s+yet\b/i,
  /\buntil\b[^.\n]{0,100}\b(?:lands?|merges?|is\s+(?:merged|implemented|done|ready|wired))\b/i,
  /\bstill\s+(?:to\s+do|to\s+be\s+done|missing|todo)\b/i,
  /\bfollow-?\s?ups?\b/i,
];

export interface PartialWorkDisclosure {
  sha: string;
  /** The sentence-ish excerpt that matched. */
  phrase: string;
  /** Ticket numbers the commit references other than its own ticket. */
  referencedTickets: number[];
}

/** Pure: the first disclosure phrase in `text`, as a short excerpt, or null. */
export function findDisclosurePhrase(text: string): string | null {
  for (const pattern of DISCLOSURE_PATTERNS) {
    const m = pattern.exec(text);
    if (m) {
      const start = Math.max(0, m.index - 30);
      return text.slice(start, m.index + m[0].length + 30).replace(/\s+/g, " ").trim();
    }
  }
  return null;
}

/** Pure: every `#N` in `text` that is not `ownIssueNumber`, deduplicated. */
export function referencedTicketNumbers(text: string, ownIssueNumber: number | null): number[] {
  const found = new Set<number>();
  for (const m of text.matchAll(/(?<![\w&])#(\d{1,6})\b/g)) {
    const n = Number(m[1]);
    if (n !== ownIssueNumber) found.add(n);
  }
  return [...found];
}

/** Pure: the commits whose message discloses unfinished work. */
export function scanCommitsForDisclosure(commits: DisclosureCommit[], ownIssueNumber: number | null): PartialWorkDisclosure[] {
  const out: PartialWorkDisclosure[] = [];
  for (const commit of commits) {
    // The Co-Authored-By trailer is never prose about the work.
    const message = `${commit.subject}\n${commit.body}`.replace(/^co-authored-by:.*$/gim, "");
    const phrase = findDisclosurePhrase(message);
    if (phrase) out.push({ sha: commit.sha, phrase, referencedTickets: referencedTicketNumbers(message, ownIssueNumber) });
  }
  return out;
}

/** Pure: the disclosures that no open follow-up ticket answers. */
export function unansweredDisclosures(disclosures: PartialWorkDisclosure[], openTickets: ReadonlySet<number>): PartialWorkDisclosure[] {
  return disclosures.filter((d) => !d.referencedTickets.some((n) => openTickets.has(n)));
}

/** The reason the board records and shows when it withholds. */
export function describePartialWorkWithhold(unanswered: PartialWorkDisclosure[]): string {
  const first = unanswered[0];
  const more = unanswered.length > 1 ? ` (+${unanswered.length - 1} more commit(s))` : "";
  return `partial work disclosed in ${first.sha.slice(0, 8)} without a follow-up ticket${more}: "${first.phrase}". `
    + "File a follow-up ticket naming what remains and reference it (#N) in that commit's message, or finish the work.";
}

export interface PartialWorkCheckResult {
  /** True when nothing unanswered was found, or the check could not run (fail-open). */
  passed: boolean;
  unanswered: PartialWorkDisclosure[];
  message: string;
}

export interface CheckPartialWorkDeps {
  workingDir: string | null;
  baseBranch: string | null;
  projectId: string;
  issueNumber: number | null;
  database?: Database;
  /** Injectable seams so a test needs no repo and no database. */
  listCommits?: (workingDir: string, baseBranch: string) => Promise<DisclosureCommit[]>;
  isOpenTicket?: (projectId: string, issueNumber: number, database: Database) => Promise<boolean>;
}

/** The branch's own commits (`base..HEAD`, no merges) with full bodies. */
export async function listBranchCommitMessages(workingDir: string, baseBranch: string): Promise<DisclosureCommit[]> {
  const res = await gitExec(["log", "--no-merges", "--format=%H%x1f%s%x1f%b%x1e", `${baseBranch}..HEAD`], { cwd: workingDir });
  if (!execSucceeded(res)) throw new Error(execErrorMessage(res));
  return res.stdout
    .split("\x1e")
    .map((rec) => rec.replace(/^\s+/, ""))
    .filter(Boolean)
    .map((rec) => {
      const [sha = "", subject = "", body = ""] = rec.split("\x1f");
      return { sha, subject, body };
    })
    .filter((c) => c.sha);
}

async function lookupOpenTicket(projectId: string, issueNumber: number, database: Database): Promise<boolean> {
  const rows = await getIssuesByProject(projectId, issueNumber, database, undefined, { excludeDescription: true });
  return rows.length > 0 && !isTerminalStatusName(rows[0].statusName);
}

/** Run the check for one branch. Total: never throws. */
export async function checkPartialWorkDisclosure(deps: CheckPartialWorkDeps): Promise<PartialWorkCheckResult> {
  const ok = (message: string): PartialWorkCheckResult => ({ passed: true, unanswered: [], message });
  if (!deps.workingDir || !deps.baseBranch) return ok("partial-work check skipped: no worktree or base branch");
  const database = deps.database ?? db;
  try {
    const commits = await (deps.listCommits ?? listBranchCommitMessages)(deps.workingDir, deps.baseBranch);
    const disclosures = scanCommitsForDisclosure(commits, deps.issueNumber);
    if (disclosures.length === 0) return ok("no commit discloses unfinished work");
    const open = new Set<number>();
    const isOpen = deps.isOpenTicket ?? lookupOpenTicket;
    for (const n of new Set(disclosures.flatMap((d) => d.referencedTickets))) {
      if (await isOpen(deps.projectId, n, database).catch(() => false)) open.add(n);
    }
    const unanswered = unansweredDisclosures(disclosures, open);
    if (unanswered.length === 0) return ok("disclosed partial work is covered by an open follow-up ticket");
    return { passed: false, unanswered, message: describePartialWorkWithhold(unanswered) };
  } catch (err) {
    return ok(`partial-work check errored (not blocking): ${errorMessage(err)}`);
  }
}
