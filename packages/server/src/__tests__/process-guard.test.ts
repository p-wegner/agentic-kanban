import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentState, kill, registerPid } from "../services/agent.service.js";

describe("process guard", () => {
  it("blocks agent cleanup from killing the board server pid", () => {
    const previousAuditLog = process.env.AGENTIC_KANBAN_PROCESS_AUDIT_LOG;
    process.env.AGENTIC_KANBAN_PROCESS_AUDIT_LOG = join(tmpdir(), `ak-process-guard-${process.pid}.log`);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    registerPid("session-points-at-board", process.pid);
    const killed = kill("session-points-at-board");

    expect(killed).toBe(false);
    expect(agentState.activePids.has("session-points-at-board")).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("blocked protected pid kill"));

    warnSpy.mockRestore();
    if (previousAuditLog === undefined) delete process.env.AGENTIC_KANBAN_PROCESS_AUDIT_LOG;
    else process.env.AGENTIC_KANBAN_PROCESS_AUDIT_LOG = previousAuditLog;
  });
});
