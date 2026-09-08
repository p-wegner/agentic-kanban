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

export function readPullState(stateDir) {
  return readJsonFile(pullStatePath(stateDir), { issues: {} });
}

export function readOutbox(stateDir) {
  return readJsonFile(outboxPath(stateDir), { entries: [] });
}
