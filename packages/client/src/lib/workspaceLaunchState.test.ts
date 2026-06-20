import { describe, it, expect } from "vitest";
import type { WorkspaceResponse } from "@agentic-kanban/shared";
import { detectQuickLaunchProvider, canResumeWorkspace, canRestartWorkspace, type RelaunchContext, type RelaunchSession } from "./workspaceLaunchState.js";

describe("detectQuickLaunchProvider", () => {
  it("uses the global default when no profile is selected", () => {
    expect(detectQuickLaunchProvider("", undefined)).toEqual({ isClaude: true, isCodex: false });
    expect(detectQuickLaunchProvider("", "codex")).toEqual({ isClaude: false, isCodex: true });
    expect(detectQuickLaunchProvider("", "copilot")).toEqual({ isClaude: false, isCodex: false });
  });
  it("reads the selected profile token prefix", () => {
    expect(detectQuickLaunchProvider("claude:anth", "codex")).toEqual({ isClaude: true, isCodex: false });
    expect(detectQuickLaunchProvider("codex:azure", undefined)).toEqual({ isClaude: false, isCodex: true });
    expect(detectQuickLaunchProvider("copilot:x", undefined)).toEqual({ isClaude: false, isCodex: false });
  });
});

const ws = (status: string) => ({ status }) as Pick<WorkspaceResponse, "status">;
const session = (id: string, providerSessionId: string | null): RelaunchSession => ({ id, providerSessionId });
const ctx = (over: Partial<RelaunchContext> = {}): RelaunchContext => ({ isRunning: false, hasActiveSession: false, lastSessionId: "s1", ...over });

describe("canResumeWorkspace / canRestartWorkspace", () => {
  it("resume requires the last session to have a provider session id", () => {
    expect(canResumeWorkspace(ws("idle"), [session("s1", "prov-1")], ctx())).toBe(true);
    expect(canResumeWorkspace(ws("idle"), [session("s1", null)], ctx())).toBe(false);
  });

  it("restart requires the last session to lack a provider session id", () => {
    expect(canRestartWorkspace(ws("idle"), [session("s1", null)], ctx())).toBe(true);
    expect(canRestartWorkspace(ws("idle"), [session("s1", "prov-1")], ctx())).toBe(false);
  });

  it("only active/idle workspaces are eligible", () => {
    expect(canResumeWorkspace(ws("active"), [session("s1", "p")], ctx())).toBe(true);
    expect(canResumeWorkspace(ws("closed"), [session("s1", "p")], ctx())).toBe(false);
    expect(canResumeWorkspace(ws("reviewing"), [session("s1", "p")], ctx())).toBe(false);
  });

  it("is false while a session is running or active, or when there is no last session", () => {
    expect(canResumeWorkspace(ws("idle"), [session("s1", "p")], ctx({ isRunning: true }))).toBe(false);
    expect(canResumeWorkspace(ws("idle"), [session("s1", "p")], ctx({ hasActiveSession: true }))).toBe(false);
    expect(canResumeWorkspace(ws("idle"), [session("s1", "p")], ctx({ lastSessionId: undefined }))).toBe(false);
  });

  it("is false when the last session id is not in the session list", () => {
    expect(canResumeWorkspace(ws("idle"), [session("other", "p")], ctx())).toBe(false);
  });
});
