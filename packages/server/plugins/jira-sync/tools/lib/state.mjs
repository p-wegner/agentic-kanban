// Small helper for the plugin's own per-project state (never board state).
// Per docs/plugin-development.md's design guidance: keep state out of the
// plugin checkout, under the env-provided JIRA_SYNC_STATE_DIR.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** A state file that exists but does not parse. Never papered over with a fallback: a
 * truncated file silently read as empty drops pending pushes/writebacks (#1732). */
export class StateFileError extends Error {
  constructor(path) {
    super(`${basename(path)} is not valid JSON`);
    this.name = "StateFileError";
    this.path = path;
  }
}

export function readJsonFile(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new StateFileError(path);
  }
}

/** Atomic: write `<file>.tmp`, then rename over the live file. */
export function writeJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}
`, "utf8");
  renameSync(tmp, path);
}

/** Loud pre-flight: `{ ok:false, step:"state", reason }` if any state file is corrupt, else null. */
export function checkStateFiles(stateDir) {
  for (const path of [
    pullStatePath(stateDir),
    outboxPath(stateDir),
    writebacksPath(stateDir),
    cursorPath(stateDir),
    conflictRegisterPath(stateDir),
    failureRegisterPath(stateDir),
    boardSnapshotPath(stateDir),
  ]) {
    try {
      readJsonFile(path, null);
    } catch (err) {
      if (err instanceof StateFileError) return { ok: false, step: "state", reason: err.message };
      throw err;
    }
  }
  return null;
}

export function pullStatePath(stateDir) {
  return join(stateDir, "pull-state.json");
}

export function outboxPath(stateDir) {
  return join(stateDir, "outbox.json");
}

/** Board-issue-id -> newly-created Jira key, for entries pushed with no `external_key` yet. */
export function writebacksPath(stateDir) {
  return join(stateDir, "writebacks.json");
}

/**
 * Last-successful-cursor/watermark for pull and push, so the loop planner can tell
 * "sync has never run" (no file / missing field) from "sync ran and nothing is
 * outstanding" without re-deriving it from pull-state/outbox contents. Written only
 * on a SUCCESSFUL (non-dry-run) run of each half; a failed run leaves the previous
 * watermark in place.
 */
export function cursorPath(stateDir) {
  return join(stateDir, "cursor.json");
}

/** Outstanding inbound-pull conflicts (#1078's `conflicted` details), keyed by Jira key,
 * carried across runs so the loop planner can tell a still-open conflict from a freshly
 * re-opened one (see conflict-register.mjs). This is a REGISTER of what's outstanding,
 * not a run log — each pull run replaces an entry's state, it never appends history. */
export function conflictRegisterPath(stateDir) {
  return join(stateDir, "conflict-register.json");
}

/** Outstanding push failures (#1079's `failed` entries), same shape/purpose as the
 * conflict register but keyed by push-entry identity (see conflict-register.mjs). */
export function failureRegisterPath(stateDir) {
  return join(stateDir, "failure-register.json");
}

/** What push last saw of the board (statuses, comments), so it can diff out new changes (#1623). */
export function boardSnapshotPath(stateDir) {
  return join(stateDir, "board-snapshot.json");
}

export function readBoardSnapshot(stateDir) {
  return readJsonFile(boardSnapshotPath(stateDir), null);
}

export function readPullState(stateDir) {
  return readJsonFile(pullStatePath(stateDir), { issues: {} });
}

export function readOutbox(stateDir) {
  return readJsonFile(outboxPath(stateDir), { entries: [] });
}

export function readWritebacks(stateDir) {
  return readJsonFile(writebacksPath(stateDir), { keys: {} });
}

export function readCursor(stateDir) {
  return readJsonFile(cursorPath(stateDir), { lastPullAt: null, lastPushAt: null });
}

export function readConflictRegister(stateDir) {
  return readJsonFile(conflictRegisterPath(stateDir), { entries: {} });
}

export function readFailureRegister(stateDir) {
  return readJsonFile(failureRegisterPath(stateDir), { entries: {} });
}

/**
 * One-time move of the pre-#1737 state dir (`<repo>/.jira-sync`, uncommitted-by-luck and shared by
 * every project on that repo) into the board-owned per-project `stateDir`. Runs only while the new
 * dir holds no state yet; the legacy dir is renamed to `<name>.migrated` afterwards so a second
 * project on the same repo does not inherit the first one's baseline. Never throws.
 * Returns "migrated" | "none" | "failed".
 */
export function migrateLegacyState(stateDir, legacyDir = process.env.JIRA_SYNC_LEGACY_STATE_DIR) {
  try {
    if (!legacyDir || !existsSync(legacyDir) || legacyDir === stateDir) return "none";
    if (readdirSync(legacyDir).length === 0) return "none";
    if (existsSync(pullStatePath(stateDir)) || existsSync(outboxPath(stateDir))) return "none";
    mkdirSync(stateDir, { recursive: true });
    cpSync(legacyDir, stateDir, { recursive: true });
    renameSync(legacyDir, `${legacyDir}.migrated`);
    return "migrated";
  } catch {
    return "failed";
  }
}
