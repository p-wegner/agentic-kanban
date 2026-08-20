import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #701 — POST /api/workspaces (and /preview) must accept the spelling everything else uses.
 *
 * The endpoint that actually starts work took ONLY a UUID, so `#701`/`701` — what CLAUDE.md,
 * the ticket titles, the commit subjects and `pnpm cli -- issue get <N>` all mean by a ticket —
 * was the one spelling it rejected, forcing a translation round trip before any start.
 *
 * The scoping half is the part worth pinning: numbers are per-project, so a numeric ref
 * without a project must FAIL rather than match an arbitrary project's #701 (the #506 bug).
 */

const createWorkspaceMock = vi.hoisted(() => vi.fn(async (input: { issueId: string }) => ({
  id: "ws-1",
  issueId: input.issueId,
  branch: "feature/ak-701-x",
})));
const previewMock = vi.hoisted(() => vi.fn(async (input: { issueId: string }) => ({
  issueId: input.issueId,
  branch: "feature/ak-701-x",
})));
const getIssueByNumberOrIdMock = vi.hoisted(() => vi.fn());
const getPreferenceMock = vi.hoisted(() => vi.fn(async () => null as string | null));

vi.mock("../services/workspace.service.js", () => ({
  createWorkspaceService: vi.fn(() => ({
    createWorkspace: createWorkspaceMock,
    computeLaunchPreview: previewMock,
  })),
}));
vi.mock("../repositories/issue/cli-commands.repository.js", () => ({
  getIssueByNumberOrId: getIssueByNumberOrIdMock,
}));
vi.mock("../repositories/preferences.repository.js", () => ({
  getPreference: getPreferenceMock,
}));

async function post(path: string, body: unknown) {
  const { createWorkspacesRoute } = await import("../routes/workspaces.js");
  const app = new Hono();
  app.route("/api/workspaces", createWorkspacesRoute({} as never, undefined, undefined));
  return app.request(`/api/workspaces${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/workspaces accepts an issue NUMBER (#701)", () => {
  beforeEach(() => {
    createWorkspaceMock.mockClear();
    previewMock.mockClear();
    getIssueByNumberOrIdMock.mockReset();
    getPreferenceMock.mockReset();
    getPreferenceMock.mockResolvedValue(null);
  });

  it("resolves a bare number against the given projectId", async () => {
    getIssueByNumberOrIdMock.mockResolvedValue({ id: "issue-uuid-701" });
    const res = await post("", { issueId: "701", projectId: "proj-1" });
    expect(res.status).toBe(201);
    expect(getIssueByNumberOrIdMock).toHaveBeenCalledWith("701", "proj-1", expect.anything());
    expect(createWorkspaceMock.mock.calls[0]?.[0].issueId).toBe("issue-uuid-701");
  });

  it("accepts the documented `#N` spelling, and via the issueNumber field", async () => {
    getIssueByNumberOrIdMock.mockResolvedValue({ id: "issue-uuid-701" });
    expect((await post("", { issueId: "#701", projectId: "proj-1" })).status).toBe(201);
    expect((await post("", { issueNumber: 701, projectId: "proj-1" })).status).toBe(201);
    expect(createWorkspaceMock.mock.calls.every((c) => c[0].issueId === "issue-uuid-701")).toBe(true);
  });

  it("falls back to the active project when no projectId is given", async () => {
    getPreferenceMock.mockResolvedValue("active-proj");
    getIssueByNumberOrIdMock.mockResolvedValue({ id: "issue-uuid-701" });
    expect((await post("", { issueId: "701" })).status).toBe(201);
    expect(getIssueByNumberOrIdMock).toHaveBeenCalledWith("701", "active-proj", expect.anything());
  });

  it("refuses a numeric ref with no project rather than matching an arbitrary one", async () => {
    const res = await post("", { issueId: "701" });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/per-project/);
    expect(getIssueByNumberOrIdMock).not.toHaveBeenCalled();
    expect(createWorkspaceMock).not.toHaveBeenCalled();
  });

  it("404s a number that does not exist in that project, naming the reason", async () => {
    getIssueByNumberOrIdMock.mockResolvedValue(null);
    const res = await post("", { issueId: "9999", projectId: "proj-1" });
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toMatch(/another project/);
    expect(createWorkspaceMock).not.toHaveBeenCalled();
  });

  it("passes a UUID straight through, with no lookup at all", async () => {
    const res = await post("", { issueId: "0df58ef3-c472-4e9b-a2aa-e955b9c60c48" });
    expect(res.status).toBe(201);
    expect(getIssueByNumberOrIdMock).not.toHaveBeenCalled();
    expect(createWorkspaceMock.mock.calls[0]?.[0].issueId).toBe("0df58ef3-c472-4e9b-a2aa-e955b9c60c48");
  });

  it("still requires some reference", async () => {
    const res = await post("", {});
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/issueId/);
  });

  it("/preview resolves a number the same way — one policy, both endpoints", async () => {
    getIssueByNumberOrIdMock.mockResolvedValue({ id: "issue-uuid-701" });
    const res = await post("/preview", { issueId: "#701", projectId: "proj-1" });
    expect(res.status).toBe(200);
    expect(previewMock.mock.calls[0]?.[0].issueId).toBe("issue-uuid-701");
  });
});
