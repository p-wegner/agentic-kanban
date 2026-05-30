import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, dirname, sep } from "node:path";

function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`git ${args.join(" ")} failed: ${stderr || err.message}`));
      } else {
        resolve(stdout.toString());
      }
    });
  });
}

/**
 * List current git worktrees as an array of { path, branch } objects.
 */
export async function listWorktrees(
  repoPath: string,
): Promise<{ path: string; branch: string }[]> {
  const output = await execGit(["worktree", "list", "--porcelain"], repoPath);
  const worktrees: { path: string; branch: string }[] = [];
  let currentPath = "";
  let currentBranch = "";

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
    } else if (line.startsWith("branch ")) {
      currentBranch = line.slice("branch ".length);
    } else if (line === "" && currentPath) {
      worktrees.push({ path: currentPath, branch: currentBranch });
      currentPath = "";
      currentBranch = "";
    }
  }
  if (currentPath) {
    worktrees.push({ path: currentPath, branch: currentBranch });
  }

  return worktrees;
}

/**
 * Create a git worktree for a branch. The worktree is created in a
 * `.worktrees/<branch>` directory sibling to the repo root.
 * If the branch doesn't exist yet, it is created from the given baseBranch
 * (or HEAD if no baseBranch is specified).
 * Throws if a worktree for this branch already exists.
 */
export async function createWorktree(
  repoPath: string,
  branch: string,
  baseBranch?: string,
): Promise<string> {
  // Prune stale worktree references (directories deleted but git still tracks them).
  // This is critical on Windows where locked directories can survive removal.
  try { await pruneWorktrees(repoPath); } catch { /* best effort */ }

  // Check if a worktree for this branch already exists — reuse if healthy
  const existing = await listWorktrees(repoPath);
  const match = existing.find(
    (wt) => wt.branch === branch || wt.branch === `refs/heads/${branch}`,
  );
  if (match) {
    // Verify the branch still exists — merged/deleted branches leave prunable worktrees
    try {
      await execGit(["rev-parse", "--verify", branch], repoPath);
      // Branch exists — reuse the worktree
      return match.path.replace(/\//g, sep);
    } catch {
      // Branch gone (merged away) — prune stale worktree and recreate
      await execGit(["worktree", "remove", "--force", match.path], repoPath);
    }
  }

  // Sanitize branch name for directory use
  const safeName = branch.replace(/[^a-zA-Z0-9._-]/g, "_");
  const worktreesDir = join(dirname(repoPath), ".worktrees");
  let worktreePath = join(worktreesDir, safeName);

  await mkdir(worktreesDir, { recursive: true });

  // If the target directory exists but isn't a registered worktree (e.g. leftover from a
  // deleted workspace), remove it so git worktree add doesn't fail with "already exists".
  // On Windows, directories can be locked by stale process handles — if rm fails, fall back
  // to an alternative path with a numeric suffix.
  try {
    await stat(worktreePath);
    // Directory exists — try to remove it
    try {
      await rm(worktreePath, { recursive: true, force: true });
    } catch {
      // Locked on Windows — find an alternative path
      for (let suffix = 2; suffix <= 10; suffix++) {
        const altPath = join(worktreesDir, `${safeName}-${suffix}`);
        try {
          await stat(altPath);
          // Alt dir also exists — skip
        } catch {
          // This alt path is free — use it
          worktreePath = altPath;
          break;
        }
      }
    }
  } catch {
    // Directory doesn't exist — nothing to clean up
  }

  // Check if branch exists; if not, create it from baseBranch (or HEAD)
  try {
    await execGit(["rev-parse", "--verify", branch], repoPath);
  } catch {
    const branchArgs = baseBranch ? ["branch", branch, baseBranch] : ["branch", branch];
    await execGit(branchArgs, repoPath);
  }

  await execGit(
    ["worktree", "add", worktreePath, branch],
    repoPath,
  );

  // Verify worktree is on the correct branch (not detached HEAD)
  await ensureOnBranch(worktreePath, branch);

  return worktreePath;
}

/** Remove a git worktree (force). */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
): Promise<void> {
  await execGit(["worktree", "remove", "--force", worktreePath], repoPath);
}

/** Prune stale worktree references (worktrees whose directories no longer exist). */
export async function pruneWorktrees(repoPath: string): Promise<void> {
  await execGit(["worktree", "prune"], repoPath);
}

/** Generate unified diff entries for untracked files (not yet git-add'd). */
async function getUntrackedDiffEntries(workdirPath: string): Promise<string> {
  const untrackedFiles = await execGit(["ls-files", "--others", "--exclude-standard"], workdirPath);
  if (!untrackedFiles.trim()) return "";

  const entries: string[] = [];
  for (const f of untrackedFiles.trim().split("\n").filter(Boolean)) {
    try {
      const content = await readFile(join(workdirPath, ...f.split("/")), "utf-8");
      const lines = content.split("\n");
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      entries.push([
        `diff --git a/${f} b/${f}`,
        `new file mode 100644`,
        `--- /dev/null`,
        `+++ b/${f}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((l) => `+${l}`),
      ].join("\n"));
    } catch {
      entries.push([
        `diff --git a/${f} b/${f}`,
        `new file mode 100644`,
        `--- /dev/null`,
        `+++ b/${f}`,
      ].join("\n"));
    }
  }
  return entries.join("\n");
}

/** Get a unified diff between the worktree's branch and a base branch, including untracked files. */
export async function getDiff(
  worktreePath: string,
  baseBranch: string = "main",
): Promise<string> {
  const tracked = await execGit(["diff", `${baseBranch}...HEAD`], worktreePath);
  const untracked = await getUntrackedDiffEntries(worktreePath);
  if (!untracked) return tracked;
  return tracked ? tracked + "\n" + untracked : untracked;
}

/** Get diff for a branch by name from the main repo (used when the worktree directory is gone). */
export async function getDiffFromRepo(
  repoPath: string,
  branch: string,
  baseBranch: string = "main",
): Promise<string> {
  return execGit(["diff", `${baseBranch}...${branch}`], repoPath);
}

/** List all local and remote branches, sorted by most recent committer date. */
export async function listBranches(
  repoPath: string,
): Promise<{ local: string[]; remote: string[] }> {
  const output = await execGit(["branch", "--all", "--sort=-committerdate"], repoPath);
  const local: string[] = [];
  const remote: string[] = [];

  for (const raw of output.split("\n")) {
    const line = raw.trim().replace(/^\* /, "");
    if (!line) continue;

    if (line.startsWith("remotes/origin/")) {
      const name = line.slice("remotes/origin/".length).replace(/\r$/, "");
      if (name !== "HEAD") {
        remote.push(name);
      }
    } else {
      local.push(line.replace(/\r$/, ""));
    }
  }

  return { local, remote };
}

/** Delete a local branch. */
export async function deleteBranch(
  repoPath: string,
  branch: string,
): Promise<void> {
  await execGit(["branch", "-d", branch], repoPath);
}

/**
 * Merge a feature branch into targetBranch using git plumbing commands only.
 *
 * Steps:
 *   1. merge-tree --write-tree  → compute merged tree (read-only)
 *   2. commit-tree              → create the merge commit object
 *   3. update-ref               → atomically advance the target branch ref
 *
 * Working-tree handling:
 * - If `targetBranch` is NOT the branch checked out in `repoPath`, the working
 *   tree and index are left untouched — safe alongside running dev servers / DB
 *   connections (no file-watcher noise, no DB-lock window).
 * - If `targetBranch` IS the branch checked out in `repoPath` (the usual case for
 *   the main checkout on `master`), advancing the ref alone would leave the
 *   working tree at the OLD commit — a silent desync where the next commit
 *   reverts the merge. In that case the working tree is synced to the new merge
 *   commit (`git reset --hard`). To avoid discarding real work, the merge is
 *   refused up-front if that checked-out branch has uncommitted tracked changes.
 * - `options.syncWorkingTree` forces the sync (e.g. for a worktree an agent
 *   continues to use even when its branch isn't the merge target).
 *
 * Throws with the conflicting file list on merge conflicts.
 */
export async function mergeBranch(
  repoPath: string,
  featureBranch: string,
  targetBranch: string,
  options?: { syncWorkingTree?: boolean },
): Promise<string> {
  const targetSha = (await execGit(["rev-parse", targetBranch], repoPath)).trim();
  const featureSha = (await execGit(["rev-parse", featureBranch], repoPath)).trim();

  // Is targetBranch the branch currently checked out in repoPath's working tree?
  // If so, we must sync the working tree after advancing the ref (otherwise it
  // desyncs). Refuse first if there are uncommitted tracked changes, since the
  // sync (`reset --hard`) would discard them. `getCurrentBranch` returns "HEAD"
  // on a detached checkout — never a real branch name — so this stays false there.
  const checkedOutBranch = await getCurrentBranch(repoPath).catch(() => "");
  const targetIsCheckedOut = checkedOutBranch === targetBranch;
  if (targetIsCheckedOut) {
    const dirty = await getUncommittedTrackedChanges(repoPath);
    if (dirty.length > 0) {
      const preview = dirty.slice(0, 5).join(", ");
      const more = dirty.length > 5 ? ` (and ${dirty.length - 5} more)` : "";
      throw new Error(
        `Cannot merge into '${targetBranch}': it is checked out in ${repoPath} with ${dirty.length} uncommitted tracked change(s): ${preview}${more}. Commit or stash them first.`,
      );
    }
  }

  // merge-tree computes the merged tree without touching the working tree.
  // Exit 0 = clean, exit 1 = conflicts; stdout always has the tree SHA on line 1.
  const { treeSha, conflictingFiles } = await new Promise<{ treeSha: string; conflictingFiles: string[] }>((resolve, reject) => {
    execFile(
      "git",
      ["merge-tree", "--write-tree", "--no-messages", targetBranch, featureBranch],
      { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 },
      (_err, stdout) => {
        const lines = stdout.toString().trim().split("\n").filter(Boolean);
        const treeSha = lines[0]?.trim() ?? "";
        if (!treeSha) {
          reject(new Error("git merge-tree produced no output"));
          return;
        }
        // Stage 1/2/3 entries indicate conflicting files: "<mode> <sha> <stage>\t<file>"
        const seen = new Set<string>();
        for (const line of lines.slice(1)) {
          const m = line.match(/^\d+ \w+ [123]\t(.+)$/);
          if (m) seen.add(m[1].replace(/\r$/, ""));
        }
        resolve({ treeSha, conflictingFiles: [...seen] });
      },
    );
  });

  if (conflictingFiles.length > 0) {
    throw new Error(`Merge conflict in: ${conflictingFiles.join(", ")}`);
  }

  // Create the merge commit with two parents
  const newCommitSha = (await execGit(
    ["commit-tree", treeSha, "-p", targetSha, "-p", featureSha, "-m", `Merge branch '${featureBranch}'`],
    repoPath,
  )).trim();

  // Atomically advance the target branch ref.
  await execGit(["update-ref", `refs/heads/${targetBranch}`, newCommitSha], repoPath);

  // Sync the working tree to the new merge commit when the target branch is
  // checked out here (otherwise repoPath silently desyncs), or when a caller
  // explicitly requests it (a worktree the agent keeps using). When the target
  // branch is not checked out, the working tree is correctly left untouched.
  if (options?.syncWorkingTree || targetIsCheckedOut) {
    await execGit(["reset", "--hard", newCommitSha], repoPath);
  }

  return `Merge branch '${featureBranch}' into ${targetBranch} (plumbing-merge: ${newCommitSha})`;
}

// --- Drizzle migration auto-renumber -------------------------------------

/** Path (relative to repo root) of the drizzle migrations directory. */
const DRIZZLE_DIR = "packages/shared/drizzle";
/** Path (relative to repo root) of the drizzle migration journal. */
const JOURNAL_PATH = `${DRIZZLE_DIR}/meta/_journal.json`;
/** Path (relative to repo root) of the server test helper that lists every migration. */
const MIGRATION_HELPER_PATH = "packages/server/src/__tests__/helpers/migrations.ts";
/** Matches a drizzle migration filename: NNNN_some_name.sql */
const MIGRATION_RE = /^(\d{4})_(.+)\.sql$/;

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}
interface MigrationJournal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

export interface RenumberResult {
  /** True when at least one migration was renamed and a commit was made. */
  renumbered: boolean;
  /** The renames performed, e.g. [{ from: "0058_foo.sql", to: "0059_foo.sql" }]. */
  renames: { from: string; to: string }[];
}

const migrationNumber = (file: string): number =>
  parseInt(file.match(MIGRATION_RE)![1], 10);
const pad4 = (n: number): string => String(n).padStart(4, "0");

/** Split git porcelain output into trimmed, non-empty lines (handles Windows CRLF). */
function splitGitLines(out: string): string[] {
  return out
    .split("\n")
    .map((l) => l.replace(/\r$/, "").trim())
    .filter(Boolean);
}

/** Read and JSON-parse the migration journal at a git ref (run in `cwd`). Returns null if absent. */
async function readJournalAtRef(cwd: string, ref: string): Promise<MigrationJournal | null> {
  try {
    const raw = await execGit(["show", `${ref}:${JOURNAL_PATH}`], cwd);
    return JSON.parse(raw) as MigrationJournal;
  } catch {
    return null;
  }
}

/** List migration .sql basenames present at a git ref (run in `cwd`). */
async function listMigrationsAtRef(cwd: string, ref: string): Promise<string[]> {
  try {
    const out = await execGit(["ls-tree", "--name-only", `${ref}:${DRIZZLE_DIR}`], cwd);
    return splitGitLines(out).filter((f) => MIGRATION_RE.test(f));
  } catch {
    return [];
  }
}

/**
 * Detect Drizzle migration-number collisions between a feature branch's worktree
 * and the target (base) branch, and rewrite the feature branch's migrations to the
 * next free numbers so the subsequent merge is conflict-free.
 *
 * Multiple feature branches independently pick the same "next" migration number
 * (e.g. all create `0058_*.sql`). The first merges cleanly; later ones collide —
 * silently (same number, different slug → git merges both files, corrupting drizzle
 * ordering) or loudly (`_journal.json` text conflict). This rewrites the *incoming*
 * branch before the merge so both failure modes are avoided.
 *
 * Operates IN THE WORKTREE (`worktreePath`, on the feature branch). It:
 *   - reads the base branch's migration state from `repoPath` (the MAIN checkout),
 *     which is the authoritative, settled ref — the worktree's own base ref may be
 *     stale relative to migrations another branch just merged;
 *   - renames each colliding `NNNN_*.sql` to the next free number;
 *   - rebuilds `_journal.json` as `[...baseEntries, ...renumberedFeatureEntries]`
 *     so the feature journal shares the base's exact prefix (no journal conflict);
 *   - updates the `MIGRATION_FILES` test helper to match the renamed files;
 *   - commits ONLY the migration paths on the feature branch and syncs the branch ref.
 *
 * No-op (`renumbered:false`) when the feature branch added no migrations. Idempotent:
 * a second call after a successful renumber finds no collisions and does nothing.
 *
 * Drizzle applies migrations in journal-array / `idx` order (the live journal's `when`
 * timestamps are NOT monotonic), so correctness rests on `idx` + array position, with
 * `when` kept monotonic only as belt-and-suspenders.
 */
export async function autoRenumberMigrations(
  worktreePath: string,
  repoPath: string,
  baseBranch: string,
): Promise<RenumberResult> {
  const noop: RenumberResult = { renumbered: false, renames: [] };

  // Files the feature branch ADDED relative to base (--diff-filter=A), scoped to drizzle.
  let addedMigrations: string[];
  try {
    const out = await execGit(
      ["diff", "--name-only", "--diff-filter=A", `${baseBranch}...HEAD`],
      worktreePath,
    );
    addedMigrations = splitGitLines(out)
      .filter((p) => p.startsWith(`${DRIZZLE_DIR}/`))
      .map((p) => p.slice(p.lastIndexOf("/") + 1))
      .filter((f) => MIGRATION_RE.test(f));
  } catch {
    return noop;
  }
  if (addedMigrations.length === 0) return noop;

  // Base ground truth from the MAIN checkout (settled under the merge lock).
  const baseFiles = await listMigrationsAtRef(repoPath, baseBranch);
  const baseJournal = await readJournalAtRef(repoPath, baseBranch);
  const featJournal = await readJournalAtRef(worktreePath, "HEAD");
  if (!baseJournal || !featJournal) return noop;

  const baseFileSet = new Set(baseFiles);
  const baseNums = new Set(baseFiles.map(migrationNumber));
  const baseTags = new Set(baseJournal.entries.map((e) => e.tag));

  // A feature migration is "new" if its filename isn't already on base.
  const featNew = addedMigrations
    .filter((f) => !baseFileSet.has(f))
    .sort((a, b) => migrationNumber(a) - migrationNumber(b));
  if (featNew.length === 0) return noop;

  // Collision = number or tag already used on base.
  const collides = (f: string): boolean =>
    baseNums.has(migrationNumber(f)) || baseTags.has(f.replace(/\.sql$/, ""));
  const hasCollision = featNew.some(collides);

  // If nothing collides AND the feature's journal already contains every base entry
  // (i.e. the feature is up to date with base), the merge is genuinely clean — leave
  // the branch untouched. Otherwise base advanced past the feature and the appended
  // journal entries would textually conflict, so we rebuild even without a collision.
  const featTags = new Set(featJournal.entries.map((e) => e.tag));
  const baseAdvanced = baseJournal.entries.some((be) => !featTags.has(be.tag));
  if (!hasCollision && !baseAdvanced) return noop;

  // Assign target numbers. If ANY feature migration collides, renumber ALL of them to
  // a contiguous block starting above the base's highest number — preserving their
  // relative order. Renumbering only the individually-colliding ones could push one
  // past another feature migration and invert their apply order. (A feature that adds
  // a non-colliding migration but where base merely advanced its journal keeps its
  // numbers; only the journal is rebuilt.)
  const baseMax = Math.max(-1, ...baseFiles.map(migrationNumber));
  const renameMap = new Map<string, string>(); // oldFile -> newFile
  if (hasCollision) {
    let target = baseMax + 1;
    for (const f of featNew) {
      const newName = f.replace(MIGRATION_RE, (_m, _n, rest) => `${pad4(target)}_${rest}.sql`);
      renameMap.set(f, newName);
      target++;
    }
  } else {
    for (const f of featNew) renameMap.set(f, f);
  }

  const renames = [...renameMap.entries()]
    .filter(([from, to]) => from !== to)
    .map(([from, to]) => ({ from, to }));

  // If no file actually moves and base didn't advance, nothing to do.
  if (renames.length === 0 && !baseAdvanced) return noop;

  // Perform file renames. Move in DESCENDING target order so a 0058->0059 rename never
  // clobbers an existing 0059 that is itself about to move to 0060.
  const migDir = join(worktreePath, ...DRIZZLE_DIR.split("/"));
  const ordered = renames.slice().sort((a, b) => migrationNumber(b.to) - migrationNumber(a.to));
  for (const { from, to } of ordered) {
    await rename(join(migDir, from), join(migDir, to));
  }

  // Rebuild the journal: base entries verbatim, then feature-added entries renumbered.
  // Sharing base's exact prefix means `_journal.json` merges without conflict.
  const featTagToFile = new Map<string, string>(featNew.map((f) => [f.replace(/\.sql$/, ""), f]));
  const featAddedEntries = featJournal.entries
    .filter((e) => featTagToFile.has(e.tag))
    .sort((a, b) => migrationNumber(`${a.tag}.sql`) - migrationNumber(`${b.tag}.sql`));

  let nextIdx = baseJournal.entries.length === 0 ? 0 : Math.max(...baseJournal.entries.map((e) => e.idx)) + 1;
  let nextWhen = Math.max(0, ...baseJournal.entries.map((e) => e.when), ...featJournal.entries.map((e) => e.when));
  const rebuiltFeatureEntries: JournalEntry[] = featAddedEntries.map((e) => {
    const oldFile = featTagToFile.get(e.tag)!;
    const newName = renameMap.get(oldFile) ?? oldFile;
    nextWhen += 1;
    return {
      idx: nextIdx++,
      version: e.version,
      when: nextWhen,
      tag: newName.replace(/\.sql$/, ""),
      breakpoints: e.breakpoints,
    };
  });

  const rebuiltJournal: MigrationJournal = {
    version: baseJournal.version,
    dialect: baseJournal.dialect,
    entries: [...baseJournal.entries, ...rebuiltFeatureEntries],
  };
  // Match drizzle's serialization: 2-space indent, single trailing newline.
  await writeFile(
    join(worktreePath, ...JOURNAL_PATH.split("/")),
    JSON.stringify(rebuiltJournal, null, 2) + "\n",
  );

  // Stage the migration dir (adds, deletes, and renames) in one shot.
  await execGit(["add", "-A", "--", DRIZZLE_DIR], worktreePath);

  // Commit ONLY the migration-related paths so we never sweep in the agent's
  // unrelated uncommitted work. Only include the test helper if it exists here.
  const commitPaths = [DRIZZLE_DIR];

  // Keep the server test helper's MIGRATION_FILES list in sync (test-only; mismatch
  // breaks unit tests, never runtime). Best-effort — the file may not exist in the worktree.
  try {
    const staged = await updateMigrationHelper(worktreePath, renames);
    if (staged) {
      await execGit(["add", "--", MIGRATION_HELPER_PATH], worktreePath);
      commitPaths.push(MIGRATION_HELPER_PATH);
    }
  } catch { /* helper sync is best-effort */ }

  const renameSummary = renames.map((r) => `${r.from}→${r.to}`).join(", ");
  await execGit(
    [
      "commit",
      "-m",
      `chore(migrations): auto-renumber to resolve conflict on merge (${renameSummary || "rejournal"})`,
      "--",
      ...commitPaths,
    ],
    worktreePath,
  );

  // Bring the base branch into the feature branch so the feature's history descends
  // from the current base. This is what makes the eventual merge-to-base conflict-free:
  // the 3-way merge's ancestor becomes the just-merged base, so `_journal.json` and the
  // (now uniquely-numbered) SQL files no longer overlap. The merge conflicts on the
  // journal (both sides edited the array tail) — we resolve it by re-writing our rebuilt
  // journal, which already incorporates base's entries as its prefix.
  const baseRef = await resolveLocalBaseRef(worktreePath, baseBranch);
  try {
    await execGit(["merge", "--no-ff", "--no-commit", "-m", `Merge ${baseBranch} for migration renumber`, baseRef], worktreePath);
  } catch {
    // Conflicts expected on the migration files (both sides edited the journal tail).
    // We only own the migration paths — if anything ELSE conflicted, abort and leave the
    // branch as it was so the normal merge conflict-resolution flow can handle it.
    const unmerged = splitGitLines(await execGit(["diff", "--name-only", "--diff-filter=U"], worktreePath).catch(() => ""));
    const nonMigration = unmerged.filter((p) => !p.startsWith(`${DRIZZLE_DIR}/`));
    if (nonMigration.length > 0) {
      await execGit(["merge", "--abort"], worktreePath).catch(() => { /* best effort */ });
      throw new Error(
        `migration renumber aborted: base merge has non-migration conflicts (${nonMigration.join(", ")})`,
      );
    }
  }
  // Re-assert the rebuilt journal as the resolution (the merge may have left conflict
  // markers in it), restage the migration dir, and commit the merge.
  await writeFile(
    join(worktreePath, ...JOURNAL_PATH.split("/")),
    JSON.stringify(rebuiltJournal, null, 2) + "\n",
  );
  await execGit(["add", "-A", "--", DRIZZLE_DIR], worktreePath);
  try {
    await execGit(["commit", "--no-edit"], worktreePath);
  } catch { /* nothing to commit — base was already an ancestor */ }

  // Make sure the branch ref points at the new commit (handles detached-HEAD edge).
  const branch = (await execGit(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath)).trim();
  if (branch && branch !== "HEAD") await syncBranchToHead(worktreePath, branch);

  return { renumbered: renames.length > 0, renames };
}

/** Resolve the base branch to a local-or-remote ref that exists from this worktree. */
async function resolveLocalBaseRef(worktreePath: string, baseBranch: string): Promise<string> {
  try {
    await execGit(["rev-parse", "--verify", baseBranch], worktreePath);
    return baseBranch;
  } catch {
    return `origin/${baseBranch}`;
  }
}

/**
 * Rewrite the MIGRATION_FILES array in the server test helper to reflect renamed files.
 * Returns true when the helper exists and was updated (so the caller can stage/commit it).
 */
async function updateMigrationHelper(
  worktreePath: string,
  renames: { from: string; to: string }[],
): Promise<boolean> {
  if (renames.length === 0) return false;
  const helperPath = join(worktreePath, ...MIGRATION_HELPER_PATH.split("/"));
  let text: string;
  try {
    text = await readFile(helperPath, "utf-8");
  } catch {
    return false; // helper not present in this worktree
  }
  for (const { from, to } of renames) {
    if (text.includes(`"${from}"`)) {
      text = text.split(`"${from}"`).join(`"${to}"`);
    } else if (!text.includes(`"${to}"`)) {
      // Old entry missing (helper was already stale) — append the new name before the closing bracket.
      text = text.replace(/(\n\];?\s*)$/, `\n  "${to}",$1`);
    }
  }
  await writeFile(helperPath, text);
  return true;
}

/**
 * Ensure a worktree's HEAD is attached to the expected branch.
 * After a failed rebase or other operation, the worktree can end up in
 * detached HEAD state — commits go nowhere and merges become no-ops.
 * This reattaches HEAD to the branch, preserving any dangling commits.
 */
export async function ensureOnBranch(
  worktreePath: string,
  branch: string,
): Promise<void> {
  const current = await execGit(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath);
  const currentBranch = current.trim();

  if (currentBranch !== branch) {
    // Worktree is detached or on wrong branch — get current HEAD commit
    const headCommit = (await execGit(["rev-parse", "HEAD"], worktreePath)).trim();

    // Force-update the branch ref to point at current HEAD (captures dangling commits)
    await execGit(["branch", "-f", branch, headCommit], worktreePath);

    // Reattach HEAD to the branch
    await execGit(["checkout", branch], worktreePath);
  }
}

/**
 * Sync the branch ref to match the worktree's HEAD.
 * Before merging, call this to ensure the branch pointer reflects
 * any commits the agent made (even if they were in detached HEAD).
 */
export async function syncBranchToHead(
  worktreePath: string,
  branch: string,
): Promise<boolean> {
  try {
    const headCommit = (await execGit(["rev-parse", "HEAD"], worktreePath)).trim();
    const branchCommit = (await execGit(["rev-parse", branch], worktreePath)).trim();

    if (headCommit !== branchCommit) {
      // HEAD is ahead of the branch (or detached) — update branch to match
      await execGit(["branch", "-f", branch, headCommit], worktreePath);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Get the current branch name of a repo. */
export async function getCurrentBranch(repoPath: string): Promise<string> {
  const output = await execGit(["rev-parse", "--abbrev-ref", "HEAD"], repoPath);
  return output.trim();
}

/** Get the current HEAD commit SHA (full 40-character hash). */
export async function getHeadCommitSha(repoPath: string): Promise<string> {
  const output = await execGit(["rev-parse", "HEAD"], repoPath);
  return output.trim();
}

/** Get diff of working tree changes against HEAD (for direct workspaces), including untracked files. */
export async function getWorkingTreeDiff(workdirPath: string): Promise<string> {
  const tracked = await execGit(["diff", "HEAD"], workdirPath);
  const untracked = await getUntrackedDiffEntries(workdirPath);
  if (!untracked) return tracked;
  return tracked ? tracked + "\n" + untracked : untracked;
}

/**
 * Fetch the latest base branch and rebase the current workspace branch onto it.
 * Returns the diff ref to use for review (e.g., "origin/main" or "main").
 * On conflict, aborts the rebase and returns success=false with conflicting file names.
 */
export async function prepareForReview(
  worktreePath: string,
  baseBranch: string,
): Promise<{ diffRef: string; success: boolean; conflictingFiles?: string[]; error?: string; uncommittedChanges?: string[] }> {
  // Abort any in-progress rebase from a prior failed attempt (idempotent retry safety)
  try {
    await execGit(["rebase", "--abort"], worktreePath);
    console.log(`[git] aborted stale in-progress rebase in ${worktreePath}`);
  } catch {
    // No rebase in progress — expected
  }

  // Check for uncommitted changes (staged or unstaged) — rebase requires a clean tree
  let uncommittedChanges: string[] | undefined;
  try {
    const statusOutput = await execGit(["status", "--porcelain"], worktreePath);
    const changedFiles = statusOutput.trim().split("\n").filter(Boolean);
    if (changedFiles.length > 0) {
      uncommittedChanges = changedFiles;
      console.log(`[git] worktree has ${changedFiles.length} uncommitted change(s) — skipping rebase`);
      // Return early: rebase would fail on a dirty tree. Let the reviewer handle it.
      return { diffRef: baseBranch, success: false, uncommittedChanges, error: "Worktree has uncommitted changes" };
    }
  } catch { /* best effort */ }

  // Try to fetch from origin (best effort — no remote is fine)
  try {
    await execGit(["fetch", "origin", baseBranch], worktreePath);
  } catch {
    // No remote configured — use local branches only
  }

  // Rebase onto the LOCAL base branch — that's where the board merges into
  // (mergeBranch targets the local default branch, never origin). In this
  // local-first app (manual merge only, no push), local master can be many
  // commits ahead of a stale origin/master; rebasing onto origin would replay
  // all local-only history and conflict spuriously. Fall back to the remote ref
  // only if the local base branch doesn't exist.
  let rebaseSource: string;
  try {
    await execGit(["rev-parse", "--verify", baseBranch], worktreePath);
    rebaseSource = baseBranch;
  } catch {
    rebaseSource = `origin/${baseBranch}`;
  }

  // Rebase the workspace branch onto the base branch
  try {
    await execGit(["rebase", rebaseSource], worktreePath);
  } catch (err) {
    // Rebase conflict — collect conflicting files, then abort to leave worktree clean
    let conflictingFiles: string[] | undefined;
    try {
      const unmerged = await execGit(["diff", "--name-only", "--diff-filter=U"], worktreePath);
      conflictingFiles = unmerged.trim().split("\n").filter(Boolean);
    } catch { /* best effort */ }
    try {
      await execGit(["rebase", "--abort"], worktreePath);
    } catch { /* best effort */ }
    return { diffRef: rebaseSource, success: false, conflictingFiles, error: err instanceof Error ? err.message : String(err) };
  }

  return { diffRef: rebaseSource, success: true };
}

/** Check if a directory is a valid git working tree (has .git file/dir). */
function isGitWorkingTree(dir: string): boolean {
  try { return existsSync(join(dir, ".git")); } catch { return false; }
}

/** Get lightweight diff stats using --shortstat (no full diff transfer). Includes untracked files. */
export async function getDiffShortstat(
  worktreePath: string,
  baseBranch: string,
): Promise<{ filesChanged: number; insertions: number; deletions: number }> {
  if (!isGitWorkingTree(worktreePath)) return { filesChanged: 0, insertions: 0, deletions: 0 };
  try {
    // For direct workspaces (baseBranch="HEAD"), compare working tree against HEAD
    // For feature branches, use three-dot to show changes since branching
    const diffArgs = baseBranch === "HEAD"
      ? ["diff", "--shortstat", "HEAD"]
      : ["diff", "--shortstat", `${baseBranch}...HEAD`];
    const output = await execGit(diffArgs, worktreePath);

    let filesChanged = 0;
    let insertions = 0;
    let deletions = 0;

    if (output.trim()) {
      const filesMatch = output.match(/(\d+) files? changed/);
      if (filesMatch) filesChanged = parseInt(filesMatch[1], 10);

      const insertionsMatch = output.match(/(\d+) insertion/);
      if (insertionsMatch) insertions = parseInt(insertionsMatch[1], 10);

      const deletionsMatch = output.match(/(\d+) deletion/);
      if (deletionsMatch) deletions = parseInt(deletionsMatch[1], 10);
    }

    const untracked = await execGit(["ls-files", "--others", "--exclude-standard"], worktreePath);
    if (untracked.trim()) {
      const untrackedList = untracked.trim().split("\n").filter(Boolean);
      filesChanged += untrackedList.length;
      for (const f of untrackedList) {
        try {
          const content = await readFile(join(worktreePath, ...f.split("/")), "utf-8");
          const lineCount = content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
          insertions += lineCount;
        } catch { /* binary or unreadable */ }
      }
    }

    return { filesChanged, insertions, deletions };
  } catch (err) {
    console.error(`[git] diff --shortstat failed in ${worktreePath}:`, err instanceof Error ? err.message : String(err));
    return { filesChanged: 0, insertions: 0, deletions: 0 };
  }
}

/**
 * List the changed file paths in a worktree (tracked changes vs baseBranch plus
 * untracked files). Used to evaluate `diff_touches` / `diff_clean` workflow edge
 * conditions. Returns [] when the dir is not a git working tree.
 */
export async function getChangedFileNames(
  worktreePath: string,
  baseBranch: string,
): Promise<string[]> {
  if (!isGitWorkingTree(worktreePath)) return [];
  try {
    const diffArgs = baseBranch === "HEAD"
      ? ["diff", "--name-only", "HEAD"]
      : ["diff", "--name-only", `${baseBranch}...HEAD`];
    const tracked = await execGit(diffArgs, worktreePath);
    const untracked = await execGit(["ls-files", "--others", "--exclude-standard"], worktreePath);
    const files = new Set<string>();
    for (const line of `${tracked}\n${untracked}`.split("\n")) {
      const f = line.trim();
      if (f) files.add(f);
    }
    return [...files];
  } catch {
    return [];
  }
}

/** Get the latest commit SHA (short) and message on the current branch. Returns null when no commits exist. */
export async function getLatestCommit(
  worktreePath: string,
): Promise<{ sha: string; message: string } | null> {
  try {
    const output = await execGit(["log", "-1", "--format=%h\t%s"], worktreePath);
    const trimmed = output.trim();
    if (!trimmed) return null;
    const tabIdx = trimmed.indexOf("\t");
    if (tabIdx === -1) return null;
    return { sha: trimmed.slice(0, tabIdx), message: trimmed.slice(tabIdx + 1) };
  } catch {
    return null;
  }
}

/**
 * Detect merge conflicts between the current branch and the base branch.
 * Uses git merge-tree (read-only, no working tree changes) — safe for concurrent calls.
 */
export async function detectConflicts(
  worktreePath: string,
  baseBranch: string,
): Promise<{ hasConflicts: boolean; conflictingFiles: string[] }> {
  return new Promise((resolve) => {
    // merge-tree exits 0 for clean merge, 1 for conflicts.
    // Stdout: tree SHA on line 1, then conflict entries (mode sha stage\tfile) for conflicting files.
    execFile(
      "git",
      ["merge-tree", "--write-tree", "--no-messages", "HEAD", baseBranch],
      { cwd: worktreePath, maxBuffer: 10 * 1024 * 1024 },
      (_err, stdout) => {
        const lines = stdout.toString().trim().split("\n").slice(1).filter(Boolean);
        // Lines with stage 1/2/3 indicate conflicting files: "<mode> <sha> <stage>\t<file>"
        const seen = new Set<string>();
        for (const line of lines) {
          const m = line.match(/^\d+ \w+ [123]\t(.+)$/);
          if (m) seen.add(m[1].replace(/\r$/, ""));
        }
        const conflictingFiles = [...seen];
        resolve({ hasConflicts: conflictingFiles.length > 0, conflictingFiles });
      },
    );
  });
}

/**
 * Rebase the current branch onto the latest base branch.
 * On conflict, returns conflicting files and leaves rebase in-progress for resolution.
 */
export async function rebaseOntoBase(
  worktreePath: string,
  baseBranch: string,
  branch?: string,
): Promise<{ success: boolean; conflictingFiles?: string[]; error?: string }> {
  try {
    await execGit(["fetch", "origin", baseBranch], worktreePath);
  } catch { /* no remote */ }

  let source = baseBranch;
  try {
    await execGit(["rev-parse", "--verify", `remotes/origin/${baseBranch}`], worktreePath);
    source = `origin/${baseBranch}`;
  } catch { /* use local */ }

  try {
    await execGit(["rebase", source], worktreePath);
    // Rebase can leave worktree in detached HEAD — reattach
    if (branch) {
      await ensureOnBranch(worktreePath, branch);
    }
    return { success: true };
  } catch (err) {
    try {
      const unmerged = await execGit(["diff", "--name-only", "--diff-filter=U"], worktreePath);
      const conflictingFiles = unmerged.trim().split("\n").filter(Boolean);
      return { success: false, conflictingFiles, error: err instanceof Error ? err.message : String(err) };
    } catch {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/**
 * Merge the base branch into the current workspace branch.
 * On conflict, returns conflicting files and leaves merge in-progress for resolution.
 */
export async function mergeBaseIntoBranch(
  worktreePath: string,
  baseBranch: string,
): Promise<{ success: boolean; conflictingFiles?: string[]; error?: string }> {
  try {
    await execGit(["fetch", "origin", baseBranch], worktreePath);
  } catch { /* no remote */ }

  let source = baseBranch;
  try {
    await execGit(["rev-parse", "--verify", `remotes/origin/${baseBranch}`], worktreePath);
    source = `origin/${baseBranch}`;
  } catch { /* use local */ }

  try {
    await execGit(["merge", source, "--no-edit"], worktreePath);
    return { success: true };
  } catch (err) {
    try {
      const unmerged = await execGit(["diff", "--name-only", "--diff-filter=U"], worktreePath);
      const conflictingFiles = unmerged.trim().split("\n").filter(Boolean);
      return { success: false, conflictingFiles, error: err instanceof Error ? err.message : String(err) };
    } catch {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** Abort an in-progress rebase. */
export async function abortRebase(worktreePath: string): Promise<void> {
  await execGit(["rebase", "--abort"], worktreePath);
}

/** Abort an in-progress merge. */
export async function abortMerge(worktreePath: string): Promise<void> {
  await execGit(["merge", "--abort"], worktreePath);
}

/**
 * Return a list of staged or unstaged changes to tracked files in repoPath.
 * Untracked (new) files are excluded because they do not block `git merge`.
 * An empty array means the working tree is clean and safe to merge into.
 */
export async function getUncommittedTrackedChanges(repoPath: string): Promise<string[]> {
  try {
    const output = await execGit(["status", "--porcelain", "--untracked-files=no"], repoPath);
    return output.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** List files changed between two refs (uses `git diff --name-only A..B`). */
export async function getChangedFilesBetween(
  repoPath: string,
  fromRef: string,
  toRef: string,
): Promise<string[]> {
  try {
    const output = await execGit(["diff", "--name-only", `${fromRef}..${toRef}`], repoPath);
    return output.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** Resolve a ref to its commit SHA (e.g. "HEAD"). */
export async function revParse(repoPath: string, ref: string): Promise<string> {
  return (await execGit(["rev-parse", ref], repoPath)).trim();
}

/** Check if a rebase is in progress in the worktree. */
export async function isRebaseInProgress(worktreePath: string): Promise<boolean> {
  try {
    const dir = (await execGit(["rev-parse", "--git-dir"], worktreePath)).trim();
    const { existsSync } = await import("node:fs");
    const { join: pathJoin } = await import("node:path");
    return existsSync(pathJoin(worktreePath, dir, "rebase-merge")) || existsSync(pathJoin(worktreePath, dir, "rebase-apply"));
  } catch {
    return false;
  }
}

/** Check if a merge is in progress (MERGE_HEAD exists). */
export async function isMergeInProgress(repoPath: string): Promise<boolean> {
  try {
    const dir = (await execGit(["rev-parse", "--git-dir"], repoPath)).trim();
    const { join: pathJoin } = await import("node:path");
    return existsSync(pathJoin(repoPath, dir, "MERGE_HEAD"));
  } catch {
    return false;
  }
}
