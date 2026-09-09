#!/usr/bin/env node
// The manifest's `loops[].plan` command for the "sync-conflicts" loop (#1080). Reads
// this project's persisted cursor/conflict/failure state (all under
// JIRA_SYNC_STATE_DIR, written by sync/pull.mjs and sync/push.mjs) and prints the
// board's loop-plan JSON on stdout. Deterministic, no network, never throws.

import { readCursor, readConflictRegister, readFailureRegister } from "./lib/state.mjs";
import { buildLoopPlan } from "./lib/loop-plan.mjs";

const stateDir = process.env.JIRA_SYNC_STATE_DIR;
if (!stateDir) {
  console.log(JSON.stringify({ units: [], converged: false, note: "JIRA_SYNC_STATE_DIR is not set" }));
  process.exit(0);
}

const plan = buildLoopPlan({
  cursor: readCursor(stateDir),
  conflictRegister: readConflictRegister(stateDir),
  failureRegister: readFailureRegister(stateDir),
});

console.log(JSON.stringify(plan, null, 2));
