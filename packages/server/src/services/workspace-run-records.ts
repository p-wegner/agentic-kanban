import type { WorkspaceSymlinkRun } from "@agentic-kanban/shared";
import type { SetupScriptResult } from "./setup-script.js";

/**
 * Pure builders for the per-workspace "latest run" status records — the setup
 * script run and the symlink-bootstrap run shown in the workspace panel.
 *
 * These were nested inside `createWorkspaceCrudService`'s closure, where their
 * state-derivation logic (success/failed/skipped/linked/disabled) and output
 * truncation could not be unit-tested. They are pure data transforms; the only
 * impurity is the end timestamp, injected as `nowIso` (defaulting to now) per
 * the project's time-dependent-test rule so duration/state are deterministic.
 */

export type SetupRunState = "running" | "success" | "failed" | "skipped";

export interface LatestSetupRun {
  command: string | null;
  state: SetupRunState;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  durationMs: number | null;
  stdoutTail: string | null;
  stderrTail: string | null;
}

export type LatestSymlinkRun = WorkspaceSymlinkRun;

/** Keep the last 8 lines of command output, capped at 2000 chars; `null` if empty. */
export function tailOutput(output: string): string | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  const lines = trimmed.split(/\r?\n/).slice(-8).join("\n");
  return lines.length > 2000 ? lines.slice(-2000) : lines;
}

function durationMs(startedAt: string, endedAt: string): number {
  return Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime());
}

export function buildSetupRunFromResult(
  command: string,
  startedAt: string,
  result: SetupScriptResult,
  nowIso: string = new Date().toISOString(),
): LatestSetupRun {
  return {
    command,
    state: result.exitCode === 0 ? "success" : "failed",
    startedAt,
    endedAt: nowIso,
    exitCode: result.exitCode,
    durationMs: durationMs(startedAt, nowIso),
    stdoutTail: tailOutput(result.stdout),
    stderrTail: tailOutput(result.stderr),
  };
}

export function buildSetupRunFromError(
  command: string,
  startedAt: string,
  err: unknown,
  nowIso: string = new Date().toISOString(),
): LatestSetupRun {
  return {
    command,
    state: "failed",
    startedAt,
    endedAt: nowIso,
    exitCode: null,
    durationMs: durationMs(startedAt, nowIso),
    stdoutTail: null,
    stderrTail: tailOutput(err instanceof Error ? err.message : String(err)),
  };
}

export function skippedSetupRun(
  command: string | null,
  nowIso: string = new Date().toISOString(),
): LatestSetupRun {
  return {
    command,
    state: "skipped",
    startedAt: nowIso,
    endedAt: nowIso,
    exitCode: null,
    durationMs: 0,
    stdoutTail: null,
    stderrTail: null,
  };
}

export function disabledSymlinkRun(nowIso: string = new Date().toISOString()): LatestSymlinkRun {
  return {
    state: "disabled",
    dirs: [],
    linked: [],
    skipped: [],
    failed: [],
    startedAt: nowIso,
    endedAt: nowIso,
    error: null,
  };
}

export function buildSymlinkRun(
  dirs: string[],
  startedAt: string,
  result: { linked: string[]; skipped: string[]; failed: Array<{ dir: string; error: string }> },
  nowIso: string = new Date().toISOString(),
): LatestSymlinkRun {
  const state = result.failed.length > 0
    ? "failed"
    : result.linked.length > 0
      ? "linked"
      : "skipped";
  return {
    state,
    dirs,
    linked: result.linked,
    skipped: result.skipped,
    failed: result.failed,
    startedAt,
    endedAt: nowIso,
    error: null,
  };
}

export function buildSymlinkErrorRun(
  dirs: string[],
  startedAt: string,
  err: unknown,
  nowIso: string = new Date().toISOString(),
): LatestSymlinkRun {
  return {
    state: "failed",
    dirs,
    linked: [],
    skipped: [],
    failed: [],
    startedAt,
    endedAt: nowIso,
    error: err instanceof Error ? err.message : String(err),
  };
}
