// #1109 — an unmatched `/api/*` route must not fall through to the SPA's `index.html`.
// Measured before this fix: `/api/preferences`, `/api/settings`, `/api/monitor/status` and
// several other real (but not-yet-mounted-here) routes all answered `200` + the SPA's
// `<!DOCTYPE html>` body, so a caller that only checks the status code concludes the route
// exists and the payload is simply empty — a wrong answer that reads as a valid one.
//
// Mirrors the mounting order in `startup/route-setup.ts`: real `/api` routes, then the
// `app.all("/api/*", ...)` 404 catch, then the SPA static fallback — rather than invoking
// `setupRoutes` itself, which needs a live DB/session-manager/board-events graph the other
// route tests in this file avoid for the same reason (see `review-route-error-mapping.test.ts`).
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";

describe("unknown /api/* routes 404 instead of falling through to the SPA (#1109)", () => {
  let tmp: string;
  let app: Hono;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "kanban-spa-fallback-"));
    writeFileSync(join(tmp, "index.html"), "<!doctype html><body>spa-shell</body>", "utf8");

    app = new Hono();
    app.get("/api/known", (c) => c.json({ ok: true }));
    app.all("/api/*", (c) => c.json({ error: "Not Found" }, 404));
    app.use("/*", serveStatic({ root: tmp }));
    app.get("*", serveStatic({ root: tmp, path: "index.html" }));
  });

  afterAll(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("still serves a known /api route", async () => {
    const res = await app.request("/api/known");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("answers an unknown /api route with 404 JSON, not the SPA shell", async () => {
    const res = await app.request("/api/preferences");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Not Found");
  });

  it("an unknown /api route with query params and sub-paths also 404s", async () => {
    for (const path of ["/api/board?projectId=x", "/api/projects/abc/autopilot", "/api/monitor/status"]) {
      const res = await app.request(path);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("spa-shell");
    }
  });

  it("a genuinely unknown non-api path still falls through to the SPA shell", async () => {
    const res = await app.request("/some/client/route");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("spa-shell");
  });
});
