// Small helper for the plugin's own per-project state (never board state).
// Per docs/plugin-development.md's design guidance: keep state out of the
// plugin checkout, under the env-provided JIRA_SYNC_STATE_DIR.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function readJsonFile(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
