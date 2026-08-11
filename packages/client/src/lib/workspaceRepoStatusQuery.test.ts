/**
 * #415 — the shared workspace-repo-status query is the panels' ONE transport:
 * concurrent consumers (matrix + activity + heatmap reacting to the same WS burst)
 * must collapse onto a single network request, and a follow-up within the freshness
 * window must not refetch at all.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { QueryClient } from "@tanstack/react-query";

const apiFetch = vi.fn();
vi.mock("./api.js", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

import { fetchWorkspaceRepoStatus, WORKSPACE_REPO_STATUS_INCLUDE } from "./workspaceRepoStatusQuery.js";

const RESPONSE = {
  projectId: "p1",
  generatedAt: "2026-08-12T00:00:00.000Z",
  include: ["merge", "conflicts", "handoff", "diffstats"],
  workspaces: [],
};

describe("fetchWorkspaceRepoStatus (#415)", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue(RESPONSE);
  });

  it("collapses concurrent panel refreshes onto ONE request", async () => {
    const qc = new QueryClient();
    const results = await Promise.all([
      fetchWorkspaceRepoStatus(qc, "p1"),
      fetchWorkspaceRepoStatus(qc, "p1"),
      fetchWorkspaceRepoStatus(qc, "p1"),
    ]);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith(
      `/api/projects/p1/workspace-repo-status?include=${WORKSPACE_REPO_STATUS_INCLUDE}`,
    );
    for (const r of results) expect(r).toEqual(RESPONSE);
  });

  it("serves a follow-up within the freshness window from cache (no second request)", async () => {
    const qc = new QueryClient();
    await fetchWorkspaceRepoStatus(qc, "p1");
    await fetchWorkspaceRepoStatus(qc, "p1");
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("keys per project — a different project fetches", async () => {
    const qc = new QueryClient();
    await fetchWorkspaceRepoStatus(qc, "p1");
    await fetchWorkspaceRepoStatus(qc, "p2");
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });
});
