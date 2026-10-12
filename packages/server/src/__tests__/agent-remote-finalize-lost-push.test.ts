import { describe, it, expect, vi, beforeEach } from "vitest";

const syncIncomingBranch = vi.fn();
vi.mock("../services/worker-remote-sync.service.js", () => ({
  syncIncomingBranch: (...a: unknown[]) => syncIncomingBranch(...a),
  clearIncomingRef: vi.fn(async () => {}),
}));

import { landSessionBranch } from "../services/agent-remote-finalize.js";

const session = { repo: { repoPath: "/r", branch: "feature/x" }, onOutput: vi.fn() } as never;

describe("landSessionBranch — #1420 worker lost after pushing", () => {
  beforeEach(() => {
    syncIncomingBranch.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("records exit 0 when a pushed result lands and the worker's exit was lost", async () => {
    syncIncomingBranch.mockResolvedValue({ ok: true, status: "updated", sha: "abc" });
    expect(await landSessionBranch("s1", session, 1, true)).toBe(0);
  });

  it("keeps the placeholder 1 when nothing was pushed", async () => {
    syncIncomingBranch.mockResolvedValue({ ok: false, status: "missing", error: "no incoming ref" });
    expect(await landSessionBranch("s1", session, 1, true)).toBe(1);
  });

  it("does not rewrite a reported exit code on the normal path", async () => {
    syncIncomingBranch.mockResolvedValue({ ok: true, status: "updated", sha: "abc" });
    expect(await landSessionBranch("s1", session, 2)).toBe(2);
  });
});
