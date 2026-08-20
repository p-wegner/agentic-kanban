import { resolve } from "node:path";

/**
 * Non-`.claude` project files the CURRENT scaffold run rewrote (package.json,
 * pnpm-workspace.yaml), keyed by repo path — consumed by `commitProjectScaffoldArtifacts`.
 *
 * Why a record rather than reading git status: those paths are ordinary project source, so
 * "is it dirty?" cannot distinguish the board's own edit from a change the user already had
 * in flight. Only a file THIS run wrote may be swept into the scaffold commit (#38). Every
 * caller (`register.ts`, `project.service.ts`) runs `ensureBuildableFromClean` and
 * `commitProjectScaffoldArtifacts` back-to-back in one process, so the record is short-lived.
 *
 * This module is the SINGLE home of that state: the producer (`buildable-from-clean.ts`, and
 * the profile-derived scaffolds via `recordScaffoldArtifactWrite`) and the consumer
 * (`commit.ts`) both import it from here. Duplicating the map into either side would make a
 * write recorded by one invisible to the other — that is exactly the #38 dirty-main bug.
 */
const scaffoldWrittenFiles = new Map<string, Set<string>>();

export function recordScaffoldWrite(repoPath: string, relPath: string): void {
  const key = resolve(repoPath);
  const set = scaffoldWrittenFiles.get(key) ?? new Set<string>();
  set.add(relPath);
  scaffoldWrittenFiles.set(key, set);
}

/**
 * Report a board-written project file (repo-relative, forward slashes) so the NEXT
 * `commitProjectScaffoldArtifacts` in this process sweeps it into the scaffold commit.
 *
 * Exists for the profile-derived scaffolds (#41): `saveStackProfile({scaffold:true})` writes the
 * starter test scaffold at a path derived from the detected stack (`tests/scaffold.test.js`,
 * `tests/test_scaffold.py`, …), so it cannot be enumerated in DURABLE_CLAUDE_SCAFFOLD_PATHS the
 * way the fixed `.claude/*` artifacts are. Same contract as the ensureBuildableFromClean record:
 * only a file THIS run wrote may be committed, and the record is consumed + cleared by the commit.
 */
export function recordScaffoldArtifactWrite(repoPath: string, relPath: string): void {
  recordScaffoldWrite(repoPath, relPath);
}

/** Read and clear the record, so a later unrelated commit run never re-sweeps stale paths. */
export function takeScaffoldWrites(repoPath: string): string[] {
  const key = resolve(repoPath);
  const set = scaffoldWrittenFiles.get(key);
  if (!set) return [];
  scaffoldWrittenFiles.delete(key);
  return [...set];
}
