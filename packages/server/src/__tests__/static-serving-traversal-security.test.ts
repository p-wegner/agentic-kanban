// Security regression test for #761 — GHSA-frvp-7c67-39w9 (and its `hono` core
// twin GHSA-wwfh-h76j-fc44): on Windows, an encoded backslash (`%5C`) in the
// request path decodes to `\`, which the Windows file resolver treats as a
// separator. Hono's router splits paths only on `/`, so `/protected%5Csecret.txt`
// is ONE segment — prefix-mounted middleware on `/protected/*` never runs — while
// `serve-static` re-resolves it into the nested file and serves it. Fixed in
// `@hono/node-server` 1.19.15 by rejecting any `\` in the decoded filename.
//
// Escape OUTSIDE the configured root was never possible (verified: every `..`
// vector is rejected by 1.19.14 too), so the real defect is a middleware-guard
// bypass on a static subtree, not arbitrary file read.
//
// Why a behaviour test and not just a version pin: this board serves its whole
// client through `serveStatic({ root: clientDir })` (src/startup/route-setup.ts)
// and Windows is its primary platform, and the pin alone is not enough — bumping
// the direct dependency left @modelcontextprotocol/sdk's vulnerable 1.19.14 copy
// in the production graph until an override deduped it. A regression via any
// route (direct spec, override, transitive copy) fails here.
//
// PROVEN TO FAIL: with @hono/node-server 1.19.14 the two `%5C` cases return 200
// and the guarded file's contents; with 1.19.17 they do not.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";

const GUARDED = "GUARDED-SECRET-BODY";

// Separator smuggling vectors. `%5C`/`%5c` are the advisory's; the raw `\` and
// the double-encoded form are controls that must stay refused as well.
const SMUGGLED = [
  "/protected%5Csecret.txt",
  "/protected%5csecret.txt",
  "/protected%5C%2E%2E%5Csecret.txt",
  "/protected\secret.txt",
  "/protected%2fsecret.txt",
];

describe("static serving does not smuggle past prefix-mounted middleware (#761, GHSA-frvp-7c67-39w9)", () => {
  let tmp: string;
  let app: Hono;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "kanban-static-traversal-"));
    mkdirSync(join(tmp, "public", "protected"), { recursive: true });
    writeFileSync(join(tmp, "public", "index.html"), "<!doctype html>public-page", "utf8");
    writeFileSync(join(tmp, "public", "protected", "secret.txt"), GUARDED, "utf8");

    // serve-static resolves `root` against process.cwd(), so hand it a relative path.
    const root = relative(process.cwd(), join(tmp, "public")).replaceAll("\\", "/");
    app = new Hono();
    app.use("/protected/*", async (c) => c.text("forbidden", 403));
    app.use("/*", serveStatic({ root }));
  });

  afterAll(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("serves an unguarded file (without this the guard assertions would pass vacuously)", async () => {
    const res = await app.request("/index.html");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("public-page");
  });

  it("lets the prefix-mounted guard block the canonical path", async () => {
    const res = await app.request("/protected/secret.txt");
    expect(res.status).toBe(403);
  });

  it.each(SMUGGLED)("does not serve the guarded file via %s", async (path) => {
    const res = await app.request(path);
    expect(await res.text()).not.toContain(GUARDED);
  });

  // `app.request()` never opens a socket, so on its own it would not show that the
  // bumped adapter can still LISTEN and stream a file — which is the other half of
  // #761's definition of done ("the server boots and the client is still served").
  // This is the same `serve()` + `serveStatic()` pair `src/server-start.ts` and
  // `src/startup/route-setup.ts` use, over a real ephemeral port.
  it("still boots on a real socket and serves the static client entry point", async () => {
    const server = await new Promise<{ address: () => { port: number } | string | null; close: (cb: () => void) => void }>(
      (resolve) => {
        const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s as never));
      },
    );
    try {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      expect(port).toBeGreaterThan(0);
      const res = await fetch(`http://127.0.0.1:${port}/index.html`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("public-page");
      const guarded = await fetch(`http://127.0.0.1:${port}/protected%5Csecret.txt`);
      expect(await guarded.text()).not.toContain(GUARDED);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
