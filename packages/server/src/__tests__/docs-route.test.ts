// @gate:always-run — reads docs/plugins from the repo tree, outside its import graph.
import { describe, it, expect } from "vitest";
import { availablePluginDocs, readPluginDoc, resolvePluginDocsDir } from "../routes/docs.js";

describe("docs route — in-board plugin guide", () => {
  it("locates docs/plugins from the dev checkout", () => {
    expect(resolvePluginDocsDir()).not.toBeNull();
  });

  it("lists a doc only when a plugin it is about is installed (public repo, non-public plugins)", () => {
    expect(availablePluginDocs([])).toEqual([]);
    expect(availablePluginDocs(["pm-pipeline", "reqextract"])).toEqual([]);
    expect(availablePluginDocs(["code-metrics"]).map((d) => d.file)).toEqual(["improvement-system-map.html"]);
  });

  it("serves the map as HTML with the requested theme stamped, but 404s without the plugins", () => {
    const r = readPluginDoc("improvement-system-map.html", { theme: "dark", installedSlugs: ["refactor-toolset"] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.contentType).toContain("text/html");
      expect(r.body).toMatch(/<html[^>]*data-theme="dark"/i);
      expect(r.body).toContain("Which part do I reach for?");
    }
    expect(readPluginDoc("improvement-system-map.html", { installedSlugs: [] })).toEqual({ ok: false, status: 404 });
  });

  it("rejects traversal and unknown files", () => {
    expect(readPluginDoc("../../package.json")).toEqual({ ok: false, status: 400 });
    expect(readPluginDoc("nope.html")).toEqual({ ok: false, status: 404 });
    expect(readPluginDoc("evil.js")).toEqual({ ok: false, status: 400 });
  });
});
