/**
 * Live progress of a HOST-run verify chain (#1462): which stage of `check:arch && typecheck &&
 * test:mine` it is in, and how many vitest files have finished.
 *
 * Worker-placed chains already report this through the worker's `verify_progress` frames; a chain
 * running on the host's own `runSetupScript` reported nothing, so `status --watch` could say a
 * chain was running but not where it was. The gate feeds the script's output through
 * {@link createVerifyOutputSink}, which turns the chunks into `{ stage, filesDone, filesTotal }`
 * patches for {@link reportVerifyChainProgress}. Pure parsing, no timers, nothing here can throw.
 */
import type { MergeGatePhase } from "@agentic-kanban/shared/lib/gate-activity";
import { reportVerifyChainProgress, workspaceVerifyChainLabel, type VerifyChainProgressPatch } from "./verify-chain-registry.js";

/** A vitest per-file pass/fail marker line (`✓ path/x.test.ts`, `FAIL path/x.test.ts`). */
const FILE_LINE = /^\s*(?:[✓√×✗✘]|FAIL\b|❯)\s+\S+\.(?:test|spec)\.[cm]?[jt]sx?/;
const FILES_SUMMARY = /Test Files\s+(?:\d+ failed\s*\|\s*)?\d+ passed(?:\s*\|[^()]*)?\s*\((\d+)\)/;

/** The stage a script output line announces, or null when it announces none. */
export function stageOfVerifyLine(line: string): string | null {
  if (FILE_LINE.test(line) || /^\s*(?:RUN|Test Files)\b/.test(line)) return "tests";
  if (/\b(?:check:arch|lint:arch|check-god-modules)\b/.test(line)) return "arch";
  if (/\btypecheck\b|\btsc\b/.test(line)) return "typecheck";
  if (/\b(?:pnpm|npm|yarn)\s+(?:install|ci)\b/.test(line)) return "setup";
  return null;
}

/** Map the merge gate's own phase onto the stage vocabulary of the chain line. `null` = leave it. */
export function stageOfGatePhase(phase: MergeGatePhase): string | null {
  switch (phase) {
    case "install": return "setup";
    case "verify": return "verify";
    case "flake-retry": return "tests";
    case "smoke": return "smoke";
    default: return null;
  }
}

/**
 * A chunk consumer for one chain: buffers partial lines across chunks and reports a patch only
 * when the stage or the file count actually moved.
 */
export function createVerifyOutputSink(report: (patch: VerifyChainProgressPatch) => void): (chunk: string) => void {
  let pending = "";
  let stage: string | null = null;
  let filesDone = 0;
  let filesTotal: number | undefined;
  const consume = (line: string): void => {
    const patch: VerifyChainProgressPatch = {};
    const next = stageOfVerifyLine(line);
    if (next && next !== stage) { stage = next; patch.stage = next; }
    if (FILE_LINE.test(line)) { filesDone++; patch.filesDone = filesDone; }
    const summary = FILES_SUMMARY.exec(line);
    if (summary) { filesDone = filesTotal = Number(summary[1]); patch.filesDone = filesDone; patch.filesTotal = filesTotal; }
    if (Object.keys(patch).length > 0) report(patch);
  };
  return (chunk) => {
    const lines = (pending + chunk).split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) consume(line);
  };
}

/** The sink the pre-merge gate hands its host script run for one workspace's chain. */
export function createWorkspaceVerifySink(workspaceId: string): (chunk: string) => void {
  const label = workspaceVerifyChainLabel(workspaceId);
  return createVerifyOutputSink((patch) => reportVerifyChainProgress(label, patch));
}
