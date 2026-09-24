/**
 * Apply a `bank-shrinks` merge fix hint to the branch worktree and commit it (#1250).
 *
 * The hint (`merge-failure-fix-hint.ts`) is a list of `{ baselineFile, key, from, to }` edits
 * a shrink-only ratchet asked for. Banking one is mechanical — lower exactly that number — so
 * this does exactly that and nothing wider:
 *  - each edit rewrites the ONE line holding the entry (`"<key>": <from>,` in a baseline map,
 *    or `const <KEY> = <from>;` for the runtime ratchet's pinned consts) and refuses when the
 *    line is missing or holds a different number than the hint says: a hint derived from an
 *    older gate run must not silently overwrite a newer banking;
 *  - the worktree must be clean in every tracked file OTHER than the baseline files — a
 *    builder's half-written edit must never be swept into a "bank the nloc shrinks" commit
 *    (the shared-index hazard the root CLAUDE.md documents), and an untracked file is left
 *    alone since `git add` only names the baseline files;
 *  - the commit goes through the git adapter (`gitExec`), never a private spawn.
 *
 * Refusals throw `UnprocessableError` so the route answers 422 with the reason; nothing here
 * touches the merge job — the route re-triggers it once the commit exists.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execSucceeded } from "@agentic-kanban/shared/lib/exec-result";
import { gitExec, gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { UnprocessableError } from "../errors/index.js";
import type { MergeFixHint, MergeFixHintEdit } from "./merge-failure-fix-hint.js";

/** The subject the banked commit carries; `#N` is the workspace's issue number. */
export function bankShrinksCommitSubject(issueNumber: number | null): string {
  const ref = issueNumber === null ? "" : `(#${issueNumber})`;
  return `test${ref}: bank the nloc shrinks the merge gate named`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `562_000` and `562000` are the same number to TypeScript and to this check. */
function numberOfLiteral(literal: string): number {
  return Number(literal.replace(/_/g, ""));
}

/**
 * Rewrite the single line that holds `edit.key` to `edit.to`. Pure. Returns the new source and
 * the number the line held, or the reason the edit cannot be applied.
 */
export function rewriteBaselineEntry(
  source: string,
  edit: MergeFixHintEdit,
): { ok: true; source: string; previous: number } | { ok: false; reason: string } {
  const key = escapeRegExp(edit.key);
  // `  "components/X.tsx::X": 570,`  or  `const BASELINE_TOTAL_MS = 562_000;`
  const re = new RegExp(`^(\\s*(?:"${key}"\\s*:|const\\s+${key}\\s*=)\\s*)(\\d[\\d_]*)(\\s*[,;].*)$`, "m");
  const m = re.exec(source);
  if (!m) return { ok: false, reason: `${edit.baselineFile} has no entry for ${edit.key}` };
  const previous = numberOfLiteral(m[2]!);
  if (edit.from !== null && previous !== edit.from) {
    return {
      ok: false,
      reason: `${edit.baselineFile} holds ${edit.key} at ${previous}, not the ${edit.from} the gate saw — re-run the merge for a current hint`,
    };
  }
  if (edit.to >= previous) {
    return { ok: false, reason: `${edit.key} is ${previous} and the hint asks for ${edit.to}, which is not a shrink` };
  }
  return { ok: true, previous, source: source.replace(re, `$1${edit.to}$3`) };
}

async function dirtyTrackedFilesOutside(workingDir: string, allowed: Set<string>): Promise<string[]> {
  const status = await gitExecOrThrow(["status", "--porcelain", "--untracked-files=no"], { cwd: workingDir });
  return status
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => line.slice(3).trim().replace(/^"(.*)"$/, "$1"))
    .filter((path) => !allowed.has(path));
}

export interface BankMergeShrinksInput {
  workingDir: string;
  issueNumber: number | null;
  hint: MergeFixHint;
}

export interface BankMergeShrinksResult {
  applied: MergeFixHintEdit[];
  /** The sha of the banking commit. */
  committed: string;
  subject: string;
}

/**
 * Apply every edit of the hint, stage the baseline files and commit on the worktree's branch.
 * Nothing is written until every edit has been checked against the file it targets, so a
 * refused hint leaves the tree exactly as found.
 */
export async function bankMergeShrinks(input: BankMergeShrinksInput): Promise<BankMergeShrinksResult> {
  const { workingDir, hint } = input;
  if (hint.kind !== "bank-shrinks" || hint.edits.length === 0) {
    throw new UnprocessableError("the merge fix hint names no baseline edits to bank");
  }
  const files = [...new Set(hint.edits.map((e) => e.baselineFile))];
  const dirty = await dirtyTrackedFilesOutside(workingDir, new Set(files));
  if (dirty.length > 0) {
    throw new UnprocessableError(
      `the worktree has uncommitted changes outside the baseline files (${dirty.join(", ")}); commit or drop them first`,
    );
  }

  const rewritten = new Map<string, string>();
  for (const file of files) {
    let source: string;
    try {
      source = await readFile(join(workingDir, file), "utf8");
    } catch {
      throw new UnprocessableError(`${file} is not readable in the worktree`);
    }
    for (const edit of hint.edits.filter((e) => e.baselineFile === file)) {
      const result = rewriteBaselineEntry(source, edit);
      if (!result.ok) throw new UnprocessableError(result.reason);
      source = result.source;
    }
    rewritten.set(file, source);
  }

  for (const [file, source] of rewritten) await writeFile(join(workingDir, file), source, "utf8");
  const subject = bankShrinksCommitSubject(input.issueNumber);
  const add = await gitExec(["add", "--", ...files], { cwd: workingDir });
  if (!execSucceeded(add)) throw new UnprocessableError(`git add failed: ${add.stderr || add.error?.message}`);
  const commit = await gitExec(["commit", "-q", "-m", subject, "--", ...files], { cwd: workingDir });
  if (!execSucceeded(commit)) {
    throw new UnprocessableError(`git commit failed: ${commit.stderr || commit.stdout || commit.error?.message}`);
  }
  const committed = (await gitExecOrThrow(["rev-parse", "HEAD"], { cwd: workingDir })).trim();
  return { applied: hint.edits, committed, subject };
}
