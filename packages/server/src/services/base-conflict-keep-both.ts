/**
 * Mechanical resolution of an append-style notes file in a base-conflict rebase (#1584).
 *
 * `CONTINUE.md` is a running log every ticket appends to, so two branches that both added a
 * section conflict on it without either being wrong. The right answer is always "keep both sides",
 * which needs no builder turn: rebase, and for each stop where ONLY allow-listed files are
 * unmerged, strip the markers keeping our and their text, `git add`, continue. Any other
 * unmerged file aborts the rebase and leaves the branch exactly as it was.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";

/** Files whose conflicts are resolved by keeping both sides. */
export const KEEP_BOTH_FILES: readonly string[] = ["CONTINUE.md"];

/** True when every conflicting file is an append-style notes file (and there is at least one). */
export function isKeepBothOnly(files: readonly string[]): boolean {
  return files.length > 0 && files.every((f) => KEEP_BOTH_FILES.includes(f.replace(/\\/g, "/")));
}

/**
 * Drop git's conflict markers, keeping both sides in order (ours, then theirs). A diff3 base
 * section (`|||||||` .. `=======`) is dropped: it is the common ancestor, not either side's edit.
 */
export function keepBothSides(content: string): string {
  const out: string[] = [];
  let inBase = false;
  for (const line of content.split("\n")) {
    if (/^<{7}( |$)/.test(line) || /^>{7}( |$)/.test(line)) continue;
    if (/^\|{7}( |$)/.test(line)) { inBase = true; continue; }
    if (/^={7}$/.test(line)) { inBase = false; continue; }
    if (!inBase) out.push(line);
  }
  return out.join("\n");
}

const MAX_REBASE_STOPS = 25;

/**
 * Rebase `worktree` onto `baseBranch`, resolving keep-both files mechanically. Returns true when
 * the branch is rebased; false (rebase aborted, branch untouched) when anything else conflicts or
 * git fails. Never throws.
 */
export async function rebaseKeepingBoth(worktree: string, baseBranch: string): Promise<boolean> {
  const git = (args: string[]) => gitExec(args, { cwd: worktree, env: { ...process.env, GIT_EDITOR: "true" }, fresh: true });
  const abort = async () => { await git(["rebase", "--abort"]).catch(() => undefined); };
  try {
    let step = await git(["rebase", baseBranch]);
    for (let i = 0; i < MAX_REBASE_STOPS && step.code !== 0; i++) {
      const unmerged = (await git(["diff", "--name-only", "--diff-filter=U"])).stdout.split("\n").map((l) => l.trim()).filter(Boolean);
      if (!isKeepBothOnly(unmerged)) { await abort(); return false; }
      for (const file of unmerged) {
        const path = join(worktree, file);
        await writeFile(path, keepBothSides(await readFile(path, "utf8")), "utf8");
        const add = await git(["add", "--", file]);
        if (add.code !== 0) { await abort(); return false; }
      }
      step = await git(["rebase", "--continue"]);
    }
    if (step.code === 0) return true;
    await abort();
    return false;
  } catch {
    await abort();
    return false;
  }
}
