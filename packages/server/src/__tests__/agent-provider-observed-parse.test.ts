import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { ClaudeProvider, CodexProvider, CopilotProvider, PiProvider, getProvider } from "../services/agent-provider.js";
import {
  getUnknownEventCounters,
  resetUnknownEventCounters,
  setUnknownEventLogger,
  type UnknownEventLogger,
} from "@agentic-kanban/shared/lib/agent-stream-parser";

/**
 * Arch-review #898: the provider adapters expose `parseStreamEventObserved`, which
 * the broadcast hot path uses so a VALID JSON event of an unknown type is counted
 * + logged instead of silently swallowed. These assert the adapter routes under
 * its own canonical provider name and does not double-count recognized events.
 */
describe("provider parseStreamEventObserved", () => {
  let restoreLogger: UnknownEventLogger;

  beforeEach(() => {
    resetUnknownEventCounters();
    restoreLogger = setUnknownEventLogger(() => {});
  });

  afterEach(() => {
    setUnknownEventLogger(restoreLogger);
    resetUnknownEventCounters();
  });

  it("every concrete provider implements parseStreamEventObserved", () => {
    for (const provider of [new ClaudeProvider(), new CodexProvider(), new CopilotProvider(), new PiProvider()]) {
      expect(typeof provider.parseStreamEventObserved).toBe("function");
    }
  });

  it("records an unknown codex event under its canonical provider name", () => {
    const provider = getProvider("codex");
    const out = provider.parseStreamEventObserved(JSON.stringify({ type: "turn.renamed_v9" }));
    expect(out).toBeUndefined();
    expect(getUnknownEventCounters().counts.get("codex:turn.renamed_v9")).toBe(1);
  });

  it("maps the legacy claude-code id to the claude canonical name", () => {
    const provider = getProvider("claude-code");
    provider.parseStreamEventObserved(JSON.stringify({ type: "some_new_claude_event" }));
    expect(getUnknownEventCounters().counts.get("claude:some_new_claude_event")).toBe(1);
  });

  it("does not count a recognized codex turn.completed (the 0-tokens regression guard)", () => {
    const provider = getProvider("codex");
    const out = provider.parseStreamEventObserved(
      JSON.stringify({ type: "turn.completed", usage: { total_token_usage: { input_tokens: 9, output_tokens: 3 } } }),
    );
    expect(out?.stats?.inputTokens).toBe(9);
    expect(getUnknownEventCounters().total).toBe(0);
  });
});
