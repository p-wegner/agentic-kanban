import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLAN_BEGIN_MARKER, PLAN_END_MARKER } from "./agent-provider.js";

/** File the parsed plan is persisted to, at the worktree root. */
export const PLAN_FILE = "PLAN.md";

/**
 * Extract the plan markdown from a plan-mode run's accumulated assistant text.
 * Prefers the sentinel-delimited block (the contract the agent is asked to emit);
 * falls back to the full trimmed text if the markers are absent.
 * Returns null only when there is no usable text at all.
 */
export function extractPlan(text: string): string | null {
  const begin = text.lastIndexOf(PLAN_BEGIN_MARKER);
  const end = text.lastIndexOf(PLAN_END_MARKER);
  if (begin !== -1 && end !== -1 && end > begin) {
    const inner = text.slice(begin + PLAN_BEGIN_MARKER.length, end).trim();
    if (inner) return inner;
  }
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Write the plan markdown to <workingDir>/PLAN.md and return the relative path. */
export function writePlanFile(workingDir: string, planText: string): string {
  writeFileSync(join(workingDir, PLAN_FILE), planText.endsWith("\n") ? planText : planText + "\n", "utf-8");
  return PLAN_FILE;
}

/** Prompt for the implementation turn that follows an approved plan. */
export function buildImplementPrompt(): string {
  return [
    `An implementation plan has been written to \`${PLAN_FILE}\` in the repository root.`,
    "Read it and implement it fully — make all the code changes it describes and run any commands needed.",
    "Do not merely restate the plan; carry it out.",
  ].join(" ");
}
