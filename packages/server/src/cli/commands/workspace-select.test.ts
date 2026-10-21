import { describe, it, expect, vi } from "vitest";
import { selectOpenWorkspaceForIssue, closeOpenWorkspaces, closeWorkspaceViaApi } from "./workspace-select.js";

const ws = (id: string, status: string) => ({ id, status, branch: `feature/${id}` });

describe("selectOpenWorkspaceForIssue", () => {
  it("picks the single open workspace, ignoring closed neighbours", () => {
    const r = selectOpenWorkspaceForIssue("#5", [ws("a", "closed"), ws("b", "idle")]);
    expect(r).toMatchObject({ ok: true, workspace: { id: "b" } });
  });

  it("refuses when the issue has more than one open workspace and none is named", () => {
    const r = selectOpenWorkspaceForIssue("#5", [ws("a", "idle"), ws("b", "active")]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("2 open workspaces");
      expect(r.message).toContain("a");
      expect(r.message).toContain("b");
    }
  });

  it("accepts a named workspace among several open ones", () => {
    const r = selectOpenWorkspaceForIssue("#5", [ws("a", "idle"), ws("b", "active")], "b");
    expect(r).toMatchObject({ ok: true, workspace: { id: "b" } });
  });

  it("refuses a named workspace that belongs to another issue", () => {
    const r = selectOpenWorkspaceForIssue("#5", [ws("a", "idle")], "zzz");
    expect(r.ok).toBe(false);
  });

  it("refuses when nothing is open", () => {
    const r = selectOpenWorkspaceForIssue("#5", [ws("a", "closed"), ws("m", "merged")]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("no open workspace");
  });
});

describe("closing over the API", () => {
  const ok = () => new Response("{}", { status: 200 });

  it("closeOpenWorkspaces closes only open workspaces and reports their branches", async () => {
    const fetchImpl = vi.fn(async () => ok()) as unknown as typeof fetch;
    const r = await closeOpenWorkspaces("3001", [ws("a", "closed"), ws("b", "idle"), ws("c", "active")], fetchImpl);
    expect(r).toEqual({ discarded: ["feature/b", "feature/c"], error: null });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("stops at the first failure", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 })) as unknown as typeof fetch;
    const r = await closeOpenWorkspaces("3001", [ws("b", "idle"), ws("c", "active")], fetchImpl);
    expect(r.discarded).toEqual([]);
    expect(r.error).toContain("boom");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("closeWorkspaceViaApi returns null on success", async () => {
    expect(await closeWorkspaceViaApi("3001", "x", (async () => ok()) as unknown as typeof fetch)).toBeNull();
  });
});
