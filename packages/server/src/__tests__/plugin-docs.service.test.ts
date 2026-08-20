import { describe, it, expect } from "vitest";
import { parsePluginManifest } from "@agentic-kanban/shared/lib/plugin-manifest";
import { stampTheme } from "../services/plugin-docs.service.js";

describe("plugin docs — manifest `docs[]` + serving", () => {
  it("parses docs entries and rejects non-doc files / traversal / duplicates", () => {
    const m = parsePluginManifest(JSON.stringify({
      id: "x", name: "X",
      docs: [{ file: "docs/map.html", title: "Guide", description: "d" }],
    }));
    expect(m.docs).toEqual([{ file: "docs/map.html", title: "Guide", description: "d", audience: undefined }]);
    for (const bad of [
      [{ file: "run.js", title: "t" }],
      [{ file: "../x.html", title: "t" }],
      [{ file: "a.html", title: "t" }, { file: "a.html", title: "u" }],
      [{ file: "a.html" }],
    ]) {
      expect(() => parsePluginManifest(JSON.stringify({ id: "x", name: "X", docs: bad }))).toThrow();
    }
  });

  it("stamps the board theme onto <html> without touching an explicit one", () => {
    expect(stampTheme("<!doctype html><html><head>", "dark")).toContain('<html data-theme="dark">');
    expect(stampTheme('<html lang="en">x', "light")).toContain('<html lang="en" data-theme="light">');
    expect(stampTheme('<html data-theme="light">', "dark")).toBe('<html data-theme="light">');
    expect(stampTheme("<html>", "purple")).toBe("<html>");
  });
});
