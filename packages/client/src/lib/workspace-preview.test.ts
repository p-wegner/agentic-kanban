import { describe, expect, it } from "vitest";
import { getWorkspacePreviewUrl } from "./workspace-preview";

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
      reason: "Preview port unavailable: workspace branch is missing.",
    });
  });

  it("explains when a parsed issue number would exceed the supported port range", () => {
    expect(getWorkspacePreviewUrl({ branch: "feature/ak-55000-too-high" })).toEqual({
      ok: false,
      reason: "Preview port 60173 is outside the supported dev range.",
    });
  });
});
