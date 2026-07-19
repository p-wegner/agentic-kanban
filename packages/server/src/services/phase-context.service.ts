/**
 * Phase Context — pre-computed, tight context injected into the REVIEW and
 * CONFLICT-RESOLUTION phase prompts (#128).
 *
 * Why: 56% of builder sessions in a fleet analysis were cold review/reconcile
 * phases. Each spun up a fresh worktree agent that rebuilt a 65k+ context from
 * scratch — `git diff --stat`, then a `git diff` per file, then re-reading the
 * tree — before doing any actual reviewing. The board already knows exactly what
 * changed, so it can hand the agent the diff instead of making it rediscover it.
 *
 * Design principles (mirroring context-packer.service.ts):
 *  - Best-effort: every section is wrapped so a git failure returns null and the
 *    caller falls back to the old "go run git diff yourself" prompt.
 *  - Size-capped: over budget, the file list + stats still go in and the agent is
 *    told to pull the diff per-file. A truncated diff would be worse than none —
 *    the reviewer would silently review half a change.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import * as gitService from "./git.service.js";

/** Budget for the inlined review diff (~15k tokens). Over this, fall back to the file list. */
export const MAX_REVIEW_DIFF_CHARS = 60_000;
/** Budget for inlined conflict hunks (~6k tokens). */
export const MAX_CONFLICT_CONTEXT_CHARS = 24_000;
/** Cap the per-file conflict excerpts so one huge file cannot crowd out the rest. */
const MAX_CONFLICT_FILES = 20;
/** Lines of surrounding context kept on each side of a conflict region. */
const CONFLICT_CONTEXT_LINES = 3;

export interface ReviewContextInput {
  workingDir: string;
  /** Ref the diff is taken against (branch name for worktrees, base sha for direct workspaces). */
  baseRef: string;
  /**
   * Direct workspaces have no worktree and no feature branch — their change is the
   * UNCOMMITTED working tree. A three-dot `<base>...HEAD` diff there is empty (HEAD is
   * the base), so the whole change would be silently invisible. Follow the convention
   * the rest of the server uses (`workspace-diff.service.ts`, `workspace-scorecard.service.ts`)
   * and compare against HEAD instead.
   */
  isDirect?: boolean | null;
  maxDiffChars?: number;
}

interface FileStat {
  added: number | null;
  deleted: number | null;
}

/**
 * Per-file added/deleted counts for tracked changes. Untracked files are absent
 * from `--numstat` and are rendered as "new file" by the caller.
 */
async function getNumstat(workingDir: string, baseRef: string): Promise<Map<string, FileStat>> {
  const stats = new Map<string, FileStat>();
  const args = baseRef === "HEAD"
    ? ["diff", "--numstat", "HEAD"]
    : ["diff", "--numstat", `${baseRef}...HEAD`];
  const { stdout, error } = await gitExec(args, { cwd: workingDir, maxBuffer: 4 * 1024 * 1024 });
  if (error) return stats;
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split("\t");
    if (parts.length < 3) continue;
    const [added, deleted, file] = parts;
    // Binary files report "-" for both counts.
    stats.set(file, {
      added: added === "-" ? null : Number(added),
      deleted: deleted === "-" ? null : Number(deleted),
    });
  }
  return stats;
}

function formatFileLine(file: string, stat: FileStat | undefined): string {
  if (!stat) return `  (new file)   ${file}`;
  if (stat.added === null || stat.deleted === null) return `  (binary)     ${file}`;
  return `  +${stat.added}/-${stat.deleted}`.padEnd(15) + file;
}

/**
 * Build the pre-computed review context block: changed-file list with per-file
 * line counts, plus the full diff when it fits the budget.
 *
 * Returns null when there is nothing changed or git is unusable — the caller then
 * emits the legacy prompt that tells the agent to run the diffs itself.
 */
export async function buildReviewContext(input: ReviewContextInput): Promise<string | null> {
  const { workingDir, baseRef, isDirect } = input;
  const maxDiffChars = input.maxDiffChars ?? MAX_REVIEW_DIFF_CHARS;
  if (!workingDir || !baseRef) return null;

  // Direct workspaces diff the working tree against HEAD; everything else is a
  // committed feature branch diffed three-dot against its base.
  const diffRef = isDirect ? "HEAD" : baseRef;

  try {
    const changedFiles = await gitService.getChangedFileNames(workingDir, diffRef);
    if (changedFiles.length === 0) return null;

    const stats = await getNumstat(workingDir, diffRef);
    let totalAdded = 0;
    let totalDeleted = 0;
    for (const s of stats.values()) {
      totalAdded += s.added ?? 0;
      totalDeleted += s.deleted ?? 0;
    }

    const lines: string[] = [];
    lines.push(
      "[PRE-COMPUTED CONTEXT — the board already computed what changed. Do NOT re-run `git diff --stat` or a per-file `git diff` to rediscover it; start reviewing straight away. Read a file only when you need surrounding context the diff below does not show.]",
    );
    lines.push("");
    lines.push(
      `Changed files vs ${diffRef} (${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"}, +${totalAdded}/-${totalDeleted}):`,
    );
    for (const f of changedFiles.slice().sort()) lines.push(formatFileLine(f, stats.get(f)));
    lines.push("");

    const diff = isDirect
      ? await gitService.getWorkingTreeDiff(workingDir)
      : await gitService.getDiff(workingDir, diffRef);
    if (!diff.trim()) {
      // File list without a diff body is still worth passing (e.g. mode-only changes).
      lines.push(`(git produced no diff body for these files — inspect them with \`git diff ${diffRef} -- <file>\`.)`);
    } else if (diff.length > maxDiffChars) {
      lines.push(
        `Full diff omitted: ${diff.length} chars exceeds the ${maxDiffChars}-char inline budget. Review file-by-file with \`git diff ${diffRef} -- <filepath>\` using the list above — do NOT dump the whole diff at once.`,
      );
    } else {
      lines.push(`Full diff vs ${diffRef}:`);
      lines.push("```diff");
      lines.push(diff.trimEnd());
      lines.push("```");
    }

    return lines.join("\n");
  } catch (err) {
    console.warn(
      `[phase-context] review context unavailable for ${workingDir}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** Extract the conflict regions (with a little surrounding context) from one file's content. */
export function extractConflictRegions(content: string): string[] {
  const lines = content.split("\n");
  const regions: string[] = [];
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("<<<<<<<")) {
      start = i;
    } else if (lines[i].startsWith(">>>>>>>") && start >= 0) {
      const from = Math.max(0, start - CONFLICT_CONTEXT_LINES);
      const to = Math.min(lines.length - 1, i + CONFLICT_CONTEXT_LINES);
      regions.push(
        lines
          .slice(from, to + 1)
          .map((l, idx) => `${String(from + idx + 1).padStart(5)}| ${l}`)
          .join("\n"),
      );
      start = -1;
    }
  }
  return regions;
}

/**
 * Build the pre-computed conflict context: the actual conflict hunks from each
 * conflicting file, so the reconciler does not have to open every file blind.
 * This is where the fleet's worst tool-failure cluster sits — the agent burned
 * calls hunting for markers across a tree it had never seen.
 */
export async function buildConflictContext(
  workingDir: string,
  conflictingFiles: string[],
  maxChars: number = MAX_CONFLICT_CONTEXT_CHARS,
): Promise<string | null> {
  if (!workingDir || conflictingFiles.length === 0) return null;

  const sections: string[] = [];
  let budget = maxChars;
  let omitted = 0;

  for (const file of conflictingFiles.slice(0, MAX_CONFLICT_FILES)) {
    if (budget <= 0) {
      omitted++;
      continue;
    }
    let content: string;
    try {
      content = await readFile(join(workingDir, ...file.split("/")), "utf-8");
    } catch {
      omitted++;
      continue;
    }
    const regions = extractConflictRegions(content);
    if (regions.length === 0) {
      omitted++;
      continue;
    }
    const section = [
      `### ${file} (${regions.length} conflict region${regions.length === 1 ? "" : "s"})`,
      "```",
      regions.join("\n...\n"),
      "```",
    ].join("\n");
    if (section.length > budget) {
      omitted++;
      continue;
    }
    budget -= section.length;
    sections.push(section);
  }

  if (conflictingFiles.length > MAX_CONFLICT_FILES) omitted += conflictingFiles.length - MAX_CONFLICT_FILES;
  if (sections.length === 0) return null;

  const header = [
    "[PRE-COMPUTED CONTEXT — the conflict regions below were extracted for you. Do NOT grep the tree for conflict markers; edit these files directly.]",
    "",
  ];
  const footer = omitted > 0
    ? ["", `(${omitted} conflicting file(s) not shown here — open them with Read and resolve them the same way.)`]
    : [];

  return [...header, ...sections, ...footer].join("\n");
}
