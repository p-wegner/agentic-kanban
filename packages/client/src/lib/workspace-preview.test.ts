import { describe, expect, it } from "vitest";
import { getWorkspacePreviewUrl, describeDevServerPlan } from "./workspace-preview";
import type { WorkspaceDevServerPlanResponse, DevServerPlan } from "@agentic-kanban/shared";

describe("getWorkspacePreviewUrl", () => {
  it("uses the main checkout client port for direct workspaces", () => {
    expect(getWorkspacePreviewUrl({ branch: "main", isDirect: true })).toEqual({
      ok: true,
      port: 5173,
      url: "http://127.0.0.1:5173",
    });
  });

  it("uses issue-number offsets for feature branches", () => {
    expect(getWorkspacePreviewUrl({ branch: "feature/ak-199-workspace-preview-url-action" })).toEqual({
      ok: true,
      port: 5372,
      url: "http://127.0.0.1:5372",
    });
  });

  it("supports feature branches without the ak prefix", () => {
    expect(getWorkspacePreviewUrl({ branch: "feature/42-old-style-branch" })).toEqual({
      ok: true,
      port: 5215,
      url: "http://127.0.0.1:5215",
    });
  });

  it("uses the deterministic hash fallback for non-standard worktree branches", () => {
    expect(getWorkspacePreviewUrl({ branch: "experiment/preview-flow" })).toEqual({
      ok: true,
      port: 5775,
      url: "http://127.0.0.1:5775",
    });
  });

  it("explains when the branch is missing", () => {
    expect(getWorkspacePreviewUrl({ branch: "" })).toEqual({
      ok: false,
      reason: "Dev ports unavailable: workspace branch is missing.",
    });
  });

  it("explains when a parsed issue number would exceed the supported port range", () => {
    expect(getWorkspacePreviewUrl({ branch: "feature/ak-55000-too-high" })).toEqual({
      ok: false,
      reason: "Dev ports 58001/60173 are outside the supported range.",
    });
  });
});

describe("describeDevServerPlan", () => {
  function plan(overrides: Partial<DevServerPlan> = {}): DevServerPlan {
    return {
      command: "pnpm dev",
      healthUrl: "http://127.0.0.1:8080/health",
      port: 8080,
      isWeb: true,
      source: { command: "profile", healthUrl: "profile", port: "profile" },
      ...overrides,
    };
  }
  function resp(p: DevServerPlan | null, isSelfProject = false): WorkspaceDevServerPlanResponse {
    return { workspaceId: "w1", isSelfProject, plan: p };
  }

  it("says so honestly when there is no dev-server plan", () => {
    const d = describeDevServerPlan(resp(null));
    expect(d.status).toBe("none");
    expect(d.previewUrl).toBeNull();
    expect(d.command).toMatch(/No dev-server command/);
  });

  it("reports the resolved endpoint + provenance for a web project", () => {
    const d = describeDevServerPlan(resp(plan()));
    expect(d.status).toBe("web");
    expect(d.endpoint).toContain("8080");
    expect(d.endpoint).toContain("stack profile");
    expect(d.previewUrl).toBe("http://127.0.0.1:8080"); // origin, path dropped
  });

  it("labels the worktree-convention source distinctly", () => {
    const d = describeDevServerPlan(resp(plan({ source: { command: "profile", healthUrl: "worktree-port", port: "worktree-port" } }), true));
    expect(d.endpoint).toContain("app worktree convention");
  });

  it("never fabricates a port when the plan can't know one", () => {
    const d = describeDevServerPlan(resp(plan({ port: null, healthUrl: null, source: { command: "profile", healthUrl: "none", port: "none" } })));
    expect(d.status).toBe("web");
    expect(d.endpoint).toMatch(/unknown/i);
    expect(d.previewUrl).toBeNull();
  });

  it("marks a headless (non-web) service with no HTTP port", () => {
    const d = describeDevServerPlan(resp(plan({ isWeb: false, port: null, healthUrl: null, source: { command: "profile", healthUrl: "none", port: "none" } })));
    expect(d.status).toBe("service");
    expect(d.endpoint).toMatch(/Headless/i);
    expect(d.previewUrl).toBeNull();
  });
});
