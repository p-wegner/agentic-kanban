// A reply still streaming when the Butler view unmounts (no SSE listener attached)
// must come back in the transcript, so the remounted chat isn't cut off (#1272).
import { describe, expect, it } from "vitest";
import { broadcast, getButlerTranscript, sessions } from "../services/butler-sdk/registry.js";
import type { ButlerSession } from "../services/butler-sdk/types.js";

function makeSession(): ButlerSession {
  return {
    projectId: "p-1272",
    butlerId: "default",
    key: "p-1272",
    backend: "mock",
    abort: new AbortController(),
    busy: true,
    contextTokens: 0,
    transcript: [{ role: "user", text: "hi", ts: 1 }],
    repoPath: "",
    systemPromptAppend: "",
    pendingQuestions: new Map(),
  };
}

describe("butler transcript while a reply is streaming", () => {
  it("includes text streamed with no listener attached, and drops it on result", () => {
    const s = makeSession();
    sessions.set(s.key, s);
    try {
      broadcast(s, { type: "turn-start" });
      broadcast(s, { type: "text", text: "Hello " });
      broadcast(s, { type: "text", text: "world" });
      const mid = getButlerTranscript("p-1272");
      expect(mid).toHaveLength(2);
      expect(mid[1]).toMatchObject({ role: "assistant", text: "Hello world" });

      s.busy = false;
      s.transcript.push({ role: "assistant", text: "Hello world", ts: 2 });
      broadcast(s, { type: "result", text: "Hello world", isError: false });
      expect(getButlerTranscript("p-1272")).toHaveLength(2);
    } finally {
      sessions.delete(s.key);
    }
  });
});
