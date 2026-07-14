import { describe, it, expect, vi } from "vitest";
import type { WorkspaceResponse } from "@agentic-kanban/shared";
import {
  fetchLatestCommits,
  fetchGithubDrafts,
  fetchPlanContents,
  fetchServiceStates,
  pickInitialWorkspaceId,
} from "./workspace-secondary-data.js";

function ws(partial: Partial<WorkspaceResponse> & { id: string }): WorkspaceResponse {
  return {
    id: partial.id,
    status: partial.status ?? "active",
    workingDir: partial.workingDir ?? null,
    pendingPlanPath: partial.pendingPlanPath,
    serviceState: partial.serviceState,
  } as WorkspaceResponse;
}

describe("pickInitialWorkspaceId", () => {
  it("returns undefined when there are no workspaces", () => {
    expect(pickInitialWorkspaceId([], null, undefined)).toBeUndefined();
  });

  it("never overrides an existing selection", () => {
    expect(pickInitialWorkspaceId([ws({ id: "a" })], "existing", "a")).toBeUndefined();
  });

  it("prefers autoSelectId when provided", () => {
    expect(pickInitialWorkspaceId([ws({ id: "a" }), ws({ id: "b" })], null, "b")).toBe("b");
  });

  it("auto-selects the sole workspace when there is exactly one and no autoSelectId", () => {
    expect(pickInitialWorkspaceId([ws({ id: "only" })], null, undefined)).toBe("only");
  });

  it("does not guess when there are multiple workspaces and no autoSelectId", () => {
    expect(pickInitialWorkspaceId([ws({ id: "a" }), ws({ id: "b" })], null, undefined)).toBeUndefined();
  });
});

describe("fetchLatestCommits", () => {
  it("only fetches workspaces with a worktree and maps sha+message", async () => {
    const apiFetch = vi.fn(async (path: string) => {
      if (path === "/api/workspaces/w1/latest-commit") return { sha: "abc", message: "fix" };
      throw new Error(`unexpected ${path}`);
    });
    const result = await fetchLatestCommits(
      [ws({ id: "w1", workingDir: "/wt" }), ws({ id: "w2", workingDir: null })],
      apiFetch as never,
    );
    expect(result).toEqual({ w1: { sha: "abc", message: "fix" } });
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("maps to null when sha or message is missing", async () => {
    const apiFetch = vi.fn(async () => ({ sha: "abc", message: null }));
    const result = await fetchLatestCommits([ws({ id: "w1", workingDir: "/wt" })], apiFetch as never);
    expect(result).toEqual({ w1: null });
  });

  it("isolates a per-workspace failure to null without rejecting the batch", async () => {
    const apiFetch = vi.fn(async (path: string) => {
      if (path.includes("/w1/")) throw new Error("boom");
      return { sha: "s", message: "m" };
    });
    const result = await fetchLatestCommits(
      [ws({ id: "w1", workingDir: "/wt" }), ws({ id: "w2", workingDir: "/wt" })],
      apiFetch as never,
    );
    expect(result).toEqual({ w1: null, w2: { sha: "s", message: "m" } });
  });
});

describe("fetchGithubDrafts", () => {
  it("only fetches closed workspaces and returns their draft content", async () => {
    const apiFetch = vi.fn(async () => ({ content: "draft body" }));
    const result = await fetchGithubDrafts(
      [ws({ id: "open", status: "active" }), ws({ id: "done", status: "closed" })],
      apiFetch as never,
    );
    expect(result).toEqual({ done: "draft body" });
    expect(apiFetch).toHaveBeenCalledWith("/api/workspaces/done/github-handoff-draft");
  });
});

describe("fetchServiceStates", () => {
  const state = {
    composeProjectName: "kanban-ws-1",
    ports: { db: 54321 },
    envFilePath: "/wt/.env",
    status: "error" as const,
    error: "compose up failed",
    updatedAt: "2026-07-14T00:00:00.000Z",
  };

  it("hydrates serviceState from the details endpoint for rows lacking it", async () => {
    const apiFetch = vi.fn(async (path: string) => {
      if (path === "/api/workspaces/w1") return { serviceState: state };
      if (path === "/api/workspaces/w2") return { serviceState: null };
      throw new Error(`unexpected ${path}`);
    });
    const result = await fetchServiceStates([ws({ id: "w1" }), ws({ id: "w2" })], apiFetch as never);
    expect(result).toEqual({ w1: state, w2: null });
  });

  it("skips workspaces whose list row already carries serviceState", async () => {
    const apiFetch = vi.fn(async () => ({ serviceState: state }));
    const result = await fetchServiceStates([ws({ id: "hydrated", serviceState: null })], apiFetch as never);
    expect(result).toEqual({});
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("isolates a per-workspace failure to null without rejecting the batch", async () => {
    const apiFetch = vi.fn(async (path: string) => {
      if (path.includes("/w1")) throw new Error("boom");
      return { serviceState: state };
    });
    const result = await fetchServiceStates([ws({ id: "w1" }), ws({ id: "w2" })], apiFetch as never);
    expect(result).toEqual({ w1: null, w2: state });
  });
});

describe("fetchPlanContents", () => {
  it("only fetches workspaces with a pending plan path AND a worktree", async () => {
    const apiFetch = vi.fn(async () => ({ content: "# plan" }));
    const result = await fetchPlanContents(
      [
        ws({ id: "no-plan", workingDir: "/wt" }),
        ws({ id: "no-wt", pendingPlanPath: "/p", workingDir: null }),
        ws({ id: "ready", pendingPlanPath: "/p", workingDir: "/wt" }),
      ],
      apiFetch as never,
    );
    expect(result).toEqual({ ready: "# plan" });
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });
});
