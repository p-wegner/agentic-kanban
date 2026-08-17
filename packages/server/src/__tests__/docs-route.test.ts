// @gate:always-run — reads docs/plugins from the repo tree, outside its import graph.
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createDocsRoute, readPluginDoc, resolvePluginDocsDir } from "../routes/docs.js";

describe("docs route — in-board plugin guide", () => {
  it("locates docs/plugins from the dev checkout", () => {
    expect(resolvePluginDocsDir()).not.toBeNull();
  });

  it("serves the improvement-system map as HTML and stamps the requested theme", async () => {
    const app = new Hono().route("/api/docs", createDocsRoute());
    const res = await app.request("/api/docs/plugins/improvement-system-map.html?theme=dark");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toMatch(/<html[^>]*data-theme="dark"/i);
    expect(body).toContain("Which part do I reach for?");
  });

  it("rejects traversal and unknown files", () => {
    expect(readPluginDoc("../../package.json")).toEqual({ ok: false, status: 400 });
    expect(readPluginDoc("nope.html")).toEqual({ ok: false, status: 404 });
    expect(readPluginDoc("evil.js")).toEqual({ ok: false, status: 400 });
  });

  it("leaves the html untouched without a theme", () => {
    const r = readPluginDoc("improvement-system-map.html");
    expect(r.ok && !/data-theme=/.test(r.body.slice(0, 200))).toBe(true);
  });
});
