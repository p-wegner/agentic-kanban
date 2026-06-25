import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLAN_BEGIN_MARKER, PLAN_END_MARKER } from "./agent-provider.js";
import type { AgentOutputMessage } from "@agentic-kanban/shared";

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

/**
 * Recursively collect every string value out of a parsed JSON object/array, so a
 * marker block buried in any field (codex `item.text`, copilot delta, etc.) is
 * found regardless of the provider's wire shape.
 */
function collectJsonStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectJsonStrings(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectJsonStrings(v, out);
  }
}

/** Pull the last sentinel-delimited plan block out of a single text blob, or null. */
function planBlockFromText(text: string): string | null {
  const begin = text.lastIndexOf(PLAN_BEGIN_MARKER);
  const end = text.lastIndexOf(PLAN_END_MARKER);
  if (begin !== -1 && end !== -1 && end > begin) {
    const inner = text.slice(begin + PLAN_BEGIN_MARKER.length, end).trim();
    if (inner) return inner;
  }
  return null;
}

/**
 * Provider-agnostic plan extraction from a session's RAW message buffer (#924).
 *
 * The per-provider stream parser is supposed to surface the final agent message
 * (carrying the `===PLAN BEGIN/END===` block) as `assistantText`, which the
 * lifecycle accumulates into `sessionFinalText`. For Claude that works; for Codex
 * the markers were observed live to slip through (the final `agent_message` was
 * not captured), leaving `planText` empty and the workspace silently stranded.
 *
 * This is the safety net: it scans the marker block out of the raw recorded
 * message `data` directly — independent of which fields the provider parser
 * populated. Each stdout chunk may hold JSONL, so it tries to JSON-parse each line
 * and pull the markers out of the DECODED string values (where escaped `\n`
 * becomes real newlines); a non-JSON line is scanned as plain text. It ONLY
 * returns a sentinel-delimited block (never the whole transcript), so it can't
 * mistake unrelated chatter for a plan.
 */
export function extractPlanFromMessages(messages: readonly AgentOutputMessage[]): string | null {
  // Pass 1: decode JSONL lines and look for the markers inside string values.
  for (const message of [...messages].reverse()) {
    const data = typeof message.data === "string" ? message.data : "";
    if (!data) continue;
    for (const line of data.split("\n").reverse()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let candidate: string | null = null;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        const strings: string[] = [];
        collectJsonStrings(parsed, strings);
        for (const s of strings) {
          candidate = planBlockFromText(s);
          if (candidate) break;
        }
      } catch {
        candidate = planBlockFromText(line);
      }
      if (candidate) return candidate;
    }
  }
  // Pass 2: last resort — the markers may straddle chunk boundaries in the raw
  // concatenated text (escapes left intact). Returns the block as-is.
  const combined = messages.map((m) => (typeof m.data === "string" ? m.data : "")).join("");
  return planBlockFromText(combined);
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

/** Prompt sent to the agent when a plan is rejected so it can revise and re-submit. */
export function buildRejectPrompt(feedback: string): string {
  return [
    `Your plan in \`${PLAN_FILE}\` was reviewed and **rejected** by the user.`,
    `\n\nUser feedback:\n${feedback}`,
    `\n\nPlease revise your plan based on this feedback and write an updated plan to \`${PLAN_FILE}\`.`,
    "When done, stop — do not start implementing yet.",
  ].join("");
}
