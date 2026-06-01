import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspacePreviewPanel } from "./WorkspacePreviewPanel.js";

describe("WorkspacePreviewPanel", () => {
  it("renders an embedded preview with refresh and external controls", () => {
    const html = renderToStaticMarkup(
      <WorkspacePreviewPanel
        branch="feature/ak-214-preview-panel"
        preview={{ ok: true, port: 5387, url: "http://127.0.0.1:5387" }}
      />,
    );

    expect(html).toContain("workspace-preview-panel");
    expect(html).toContain("Workspace preview for feature/ak-214-preview-panel");
    expect(html).toContain("http://127.0.0.1:5387");
    expect(html).toContain('src="http://127.0.0.1:5387"');
    expect(html).toContain('aria-label="Refresh preview"');
    expect(html).toContain('aria-label="Open preview externally"');
  });

  it("renders an unavailable state without an iframe when no preview URL can be inferred", () => {
    const html = renderToStaticMarkup(
      <WorkspacePreviewPanel
        branch={null}
        preview={{ ok: false, reason: "Preview port unavailable: workspace branch is missing." }}
      />,
    );

    expect(html).toContain("workspace-preview-unavailable");
    expect(html).toContain("Preview unavailable");
    expect(html).toContain("Preview port unavailable: workspace branch is missing.");
    expect(html).not.toContain("<iframe");
  });
});
