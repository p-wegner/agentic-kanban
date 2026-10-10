import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { persistRemoteStdout } from "../services/agent-remote-transcript.js";
import { readSessionStdoutFile, sessionOutputPath } from "@agentic-kanban/shared/lib/session-files";

const SID = `remote-transcript-test-${Date.now()}`;

afterEach(() => rmSync(sessionOutputPath(SID), { force: true }));

describe("persistRemoteStdout (#1333)", () => {
  it("appends streamed stdout so /output serves the assistant messages", () => {
    persistRemoteStdout({ type: "stdout", sessionId: SID, data: '{"type":"assistant","n":1}\n' });
    persistRemoteStdout({ type: "stdout", sessionId: SID, data: '{"type":"assistant","n":2}\n' });
    expect(readSessionStdoutFile(SID)).toBe('{"type":"assistant","n":1}\n{"type":"assistant","n":2}\n');
  });

  it("ignores non-stdout events and empty chunks", () => {
    persistRemoteStdout({ type: "stderr", sessionId: SID, data: "boom" });
    persistRemoteStdout({ type: "exit", sessionId: SID });
    persistRemoteStdout({ type: "stdout", sessionId: SID, data: "" });
    expect(readSessionStdoutFile(SID)).toBeNull();
  });
});
