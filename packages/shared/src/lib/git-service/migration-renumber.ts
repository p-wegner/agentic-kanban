import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execGit, splitGitLines } from "./internal.js";
import { syncBranchToHead } from "./branch-attach.js";

/** Path (relative to repo root) of the drizzle migrations directory. */
const DRIZZLE_DIR = "packages/shared/drizzle";
/** Path (relative to repo root) of the drizzle migration journal. */
const JOURNAL_PATH = `${DRIZZLE_DIR}/meta/_journal.json`;
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

  // The server test helper now reads from the drizzle journal dynamically,
  // so no manual sync of a hardcoded MIGRATION_FILES list is needed.
  // The journal itself was rewritten above and is already staged.

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
  // Guard EVERY staged drizzle file (all .sql files + meta/*.json), not just the
  // journal re-asserted above: if both branches edited the same existing migration
  // .sql, the merge leaves "<<<<<<<" markers in it, and committing that corrupts the
  // migration (fatal SQL parse error on a fresh migrate). Abort and surface it instead.
  const markerFiles = await listStagedConflictMarkerFiles(worktreePath);
  if (markerFiles.length > 0) {
    await execGit(["merge", "--abort"], worktreePath).catch(() => { /* best effort */ });
    throw new Error(
      `migration renumber aborted: conflict markers left in drizzle files (${markerFiles.join(", ")})`,
    );
  }
  try {
    await execGit(["commit", "--no-edit"], worktreePath);
  } catch { /* nothing to commit — base was already an ancestor */ }

  // Make sure the branch ref points at the new commit (handles detached-HEAD edge).
  const branch = (await execGit(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath)).trim();
  if (branch && branch !== "HEAD") await syncBranchToHead(worktreePath, branch);

  return { renumbered: renames.length > 0, renames };
}

/**
 * List staged files under the drizzle dir whose STAGED (index) content still contains
 * git conflict markers — lines starting with "<<<<<<<". Scans `--cached` so it sees
 * exactly what the upcoming commit would contain. `git grep` exits non-zero when
 * nothing matches, so failures are treated as "no markers".
 */
async function listStagedConflictMarkerFiles(worktreePath: string): Promise<string[]> {
  const out = await execGit(
    ["grep", "--cached", "--name-only", "-e", "^<<<<<<<", "--", DRIZZLE_DIR],
    worktreePath,
  ).catch(() => "");
  return splitGitLines(out);
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
