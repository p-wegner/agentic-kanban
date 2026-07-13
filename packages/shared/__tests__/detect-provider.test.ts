import { describe, it, expect, beforeEach } from "vitest";
import {
  detectAgentEventProvider,
  detectAgentEventProviderOrUnknown,
} from "../src/lib/agent-stream/detect-provider.js";
import {
  resetUnknownFieldCounters,
  getUnknownFieldCounters,
} from "../src/lib/agent-stream/unknown-fields.js";

// arch-review §2.4 (Ticket 13): the offline provider classifier must no longer
// SILENTLY claim an unrecognized event is Copilot. Recognized shapes still route
// to their provider; unrecognized shapes are reported as "unknown" + logged.
describe("detectAgentEventProviderOrUnknown", () => {
  beforeEach(() => resetUnknownFieldCounters());

  it("classifies recognized Claude/Codex/Pi event types", () => {
    expect(detectAgentEventProviderOrUnknown({ type: "system" })).toBe("claude");
    expect(detectAgentEventProviderOrUnknown({ type: "result" })).toBe("claude");
    expect(detectAgentEventProviderOrUnknown({ type: "thread.started" })).toBe("codex");
    expect(detectAgentEventProviderOrUnknown({ type: "turn.completed" })).toBe("codex");
    expect(detectAgentEventProviderOrUnknown({ type: "message_end" })).toBe("pi");
  });

  it("routes assistant-with-content-array to claude, content-less assistant to copilot", () => {
    expect(
      detectAgentEventProviderOrUnknown({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
    ).toBe("claude");
    expect(
      detectAgentEventProviderOrUnknown({ type: "assistant", message: { content: "hi" } }),
    ).toBe("copilot");
  });

  it("reports an unrecognized event as 'unknown' (NOT copilot) and logs the drift", () => {
    const provider = detectAgentEventProviderOrUnknown({ type: "totally_made_up_event" });
    expect(provider).toBe("unknown");
    // The drift is observable via the unknown-field telemetry counter.
    const counters = getUnknownFieldCounters();
    expect(counters.total).toBeGreaterThan(0);
    expect([...counters.counts.keys()].some((k) => k.startsWith("unknown:"))).toBe(true);
  });

  it("back-compat detectAgentEventProvider maps unknown → copilot (tolerant parser routing)", () => {
    expect(detectAgentEventProvider({ type: "totally_made_up_event" })).toBe("copilot");
    expect(detectAgentEventProvider({ type: "system" })).toBe("claude");
  });
});
