import { describe, it, expect } from "vitest";
import { extractPlan, extractPlanFromMessages, PLAN_FILE, buildImplementPrompt } from "../services/plan-mode.service.js";
import { PLAN_BEGIN_MARKER, PLAN_END_MARKER } from "../services/agent-provider.js";
import type { AgentOutputMessage } from "@agentic-kanban/shared";

describe("extractPlan", () => {
  it("extracts the block between sentinels", () => {
    const text = `Some preamble.\n${PLAN_BEGIN_MARKER}\n# Plan\n1. Do a thing\n${PLAN_END_MARKER}\ntrailing`;
    expect(extractPlan(text)).toBe("# Plan\n1. Do a thing");
  });

  it("uses the last sentinel pair when markers appear more than once", () => {
    const text = `${PLAN_BEGIN_MARKER}\nold\n${PLAN_END_MARKER}\n${PLAN_BEGIN_MARKER}\nnew plan\n${PLAN_END_MARKER}`;
    expect(extractPlan(text)).toBe("new plan");
  });

  it("falls back to the full trimmed text when markers are absent", () => {
    expect(extractPlan("  just a plan, no markers  ")).toBe("just a plan, no markers");
  });

  it("returns null for empty/whitespace text", () => {
    expect(extractPlan("   \n  ")).toBeNull();
    expect(extractPlan("")).toBeNull();
  });

  it("falls back to full text when the block is empty", () => {
    const text = `before\n${PLAN_BEGIN_MARKER}\n\n${PLAN_END_MARKER}`;
    expect(extractPlan(text)).toContain(PLAN_BEGIN_MARKER);
  });
});

/** Build a single stdout message carrying one or more JSONL lines (a stream chunk). */
function stdoutChunk(lines: string[]): AgentOutputMessage {
  return { type: "stdout", sessionId: "s1", data: lines.join("\n") + "\n" };
}

const PLAN_BODY = "# Implementation Plan\n1. Combine the coupled tickets\n2. Update the board";

describe("extractPlanFromMessages — provider parity (#924)", () => {
  it("extracts the plan from a representative CODEX stream (agent_message item)", () => {
    // Codex emits the final assistant text as an `item.completed`/`agent_message` whose
    // `text` field holds the marker block with REAL newlines (JSON-encoded as \n).
    const agentText = `Here is my plan.\n\n${PLAN_BEGIN_MARKER}\n${PLAN_BODY}\n${PLAN_END_MARKER}\nDone.`;
    const messages = [
      stdoutChunk([JSON.stringify({ type: "thread.started", thread_id: "t1" })]),
      stdoutChunk([JSON.stringify({ type: "item.started", item: { id: "i1", type: "reasoning", text: "thinking" } })]),
      stdoutChunk([JSON.stringify({ type: "item.completed", item: { id: "i2", type: "agent_message", text: agentText } })]),
      stdoutChunk([JSON.stringify({ type: "turn.completed", usage: {} })]),
    ];
    expect(extractPlanFromMessages(messages)).toBe(PLAN_BODY);
  });

  it("extracts the plan from a representative CLAUDE stream (assistant message content)", () => {
    const agentText = `${PLAN_BEGIN_MARKER}\n${PLAN_BODY}\n${PLAN_END_MARKER}`;
    const messages = [
      stdoutChunk([JSON.stringify({ type: "system", subtype: "init", session_id: "abc" })]),
      stdoutChunk([JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: agentText }] },
      })]),
      stdoutChunk([JSON.stringify({ type: "result", subtype: "success" })]),
    ];
    expect(extractPlanFromMessages(messages)).toBe(PLAN_BODY);
  });

  it("extracts the plan from a representative COPILOT stream", () => {
    const agentText = `${PLAN_BEGIN_MARKER}\n${PLAN_BODY}\n${PLAN_END_MARKER}`;
    const messages = [
      stdoutChunk([JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: agentText }] } })]),
    ];
    expect(extractPlanFromMessages(messages)).toBe(PLAN_BODY);
  });

  it("extracts the plan from a PI stream (agent text field)", () => {
    const agentText = `${PLAN_BEGIN_MARKER}\n${PLAN_BODY}\n${PLAN_END_MARKER}`;
    const messages = [
      stdoutChunk([JSON.stringify({ type: "assistant", text: agentText })]),
    ];
    expect(extractPlanFromMessages(messages)).toBe(PLAN_BODY);
  });

  it("recovers the plan even when markers straddle two stdout chunks (non-JSON output)", () => {
    // Some providers / mock agents print plain text. The block can span chunk boundaries.
    const messages = [
      { type: "stdout", sessionId: "s1", data: `preamble ${PLAN_BEGIN_MARKER}\n${PLAN_BODY}` } as AgentOutputMessage,
      { type: "stdout", sessionId: "s1", data: `\n${PLAN_END_MARKER}\ntrailing` } as AgentOutputMessage,
    ];
    expect(extractPlanFromMessages(messages)).toBe(PLAN_BODY);
  });

  it("uses the LAST marker pair when a plan was revised mid-stream", () => {
    const text = `${PLAN_BEGIN_MARKER}\nold plan\n${PLAN_END_MARKER}\n${PLAN_BEGIN_MARKER}\n${PLAN_BODY}\n${PLAN_END_MARKER}`;
    const messages = [stdoutChunk([JSON.stringify({ type: "item.completed", item: { id: "i", type: "agent_message", text } })])];
    expect(extractPlanFromMessages(messages)).toBe(PLAN_BODY);
  });

  it("returns null when no marker block is present (won't mistake chatter for a plan)", () => {
    const messages = [
      stdoutChunk([JSON.stringify({ type: "item.completed", item: { id: "i", type: "agent_message", text: "I'll keep this plan-only as requested, no markers here." } })]),
    ];
    expect(extractPlanFromMessages(messages)).toBeNull();
  });

  it("returns null for an empty buffer", () => {
    expect(extractPlanFromMessages([])).toBeNull();
  });
});

describe("plan-mode constants", () => {
  it("persists to PLAN.md", () => {
    expect(PLAN_FILE).toBe("PLAN.md");
  });

  it("implementation prompt references the plan file", () => {
    expect(buildImplementPrompt()).toContain(PLAN_FILE);
  });
});
