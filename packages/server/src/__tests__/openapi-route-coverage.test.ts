// @gate:always-run
//
// #805 — the OTHER half of the openapi gate. `openapi-drift.test.ts` proves the committed
// spec matches what the generator PRODUCES; this suite proves the generator LOOKS everywhere.
//
// The generator used to scan `src/routes/*.ts` only. `POST /api/workspaces/:id/review` was
// defined inline in `startup/route-setup.ts`, three `/api/internal/*` routes were registered
// straight on the app from `routes/internal-monitor.ts`, and all twelve `/api/workers*`
// endpoints lived in private `registerXRoutes(router, …)` helpers. None of them reached the
// spec — while the run printed an `unresolved` list, so a reader reasonably concluded that
// anything NOT on that list was covered. A silent gap under an explicit coverage report is a
// false assurance, which is worse than a plain omission.
//
// This suite spawns the generator over the whole `packages/server/src` tree, so it reaches
// state far outside its own import graph — hence the marker.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  DECLARED_BLIND_SPOTS,
  findRouteDefinitionSites,
  isDeclaredBlindSpot,
} from "../../scripts/generate-openapi.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const SERVER_ROOT = join(REPO_ROOT, "packages/server");
const GENERATOR = join(SERVER_ROOT, "scripts/generate-openapi.ts");
const SPEC = join(SERVER_ROOT, "openapi.yaml");
const TSX_CLI = join(
  dirname(createRequire(join(SERVER_ROOT, "package.json")).resolve("tsx/package.json")),
  "dist/cli.mjs",
);

function runGenerator(args: string[]): { ok: boolean; output: string } {
  try {
    const out = execFileSync(process.execPath, [TSX_CLI, GENERATOR, ...args], {
      cwd: SERVER_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output: out };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` || (e.message ?? "") };
  }
}

/** A throwaway tree holding one route the generator has no way to have scanned. */
function withRogueRouteDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "ak-openapi-rogue-"));
  try {
    writeFileSync(
      join(dir, "rogue.ts"),
      [
        'import { Hono } from "hono";',
        "const app = new Hono();",
        'app.get("/api/rogue-endpoint", (c) => c.json({ ok: true }));',
        "",
      ].join("\n"),
      "utf8",
    );
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("openapi route coverage (#805)", () => {
  it("the routes that used to be invisible are in the committed spec", () => {
    const spec = readFileSync(SPEC, "utf8");
    // The five registered in `startup/route-setup.ts`. The fifth, the `app.get("*")` SPA
    // fallback, is not an operation and is asserted as a DECLARED exclusion below instead.
    expect(spec).toContain("  /api/workspaces/{id}/review:");
    expect(spec).toContain("  /ws/sessions/{sessionId}:");
    expect(spec).toContain("  /ws/board/{projectId}:");
    expect(spec).toContain("  /ws/workers/{id}:");
    // Found by the same audit, in two more shapes the generator had never looked at.
    expect(spec).toContain("  /health:");
    expect(spec).toContain("  /api/internal/monitor-status:");
    expect(spec).toContain("  /api/internal/monitor-run:");
    expect(spec).toContain("  /api/internal/resource-sweep:");
    expect(spec).toContain("  /api/workers/pairing-token:");
    expect(spec).toContain("  /api/workers/{id}/heartbeat:");
  });

  it("the spec STATES its coverage rather than leaving absence to be inferred", () => {
    const spec = readFileSync(SPEC, "utf8");
    expect(spec).toContain("x-coverage:");
    for (const blindSpot of DECLARED_BLIND_SPOTS) {
      expect(spec).toContain(blindSpot.file);
    }
  });

  it("the site detector finds a route defined outside every shape the generator resolves", () => {
    withRogueRouteDir((dir) => {
      const sites = findRouteDefinitionSites(dir);
      expect(sites).toHaveLength(1);
      expect(sites[0]).toMatchObject({ rel: "rogue.ts", method: "get", pathLiteral: "/api/rogue-endpoint" });
      // And nothing quietly excuses it — an exemption has to be written down.
      expect(isDeclaredBlindSpot(sites[0]!.rel, sites[0]!.pathLiteral)).toBeUndefined();
    });
  });

  it("the generator FAILS on an undeclared route rather than reporting full coverage", () => {
    // The negative control, in a throwaway tree: proving the gate bites must not require a
    // writable file in this shared checkout (#814).
    const before = readFileSync(SPEC, "utf8");
    withRogueRouteDir((dir) => {
      const { ok, output } = runGenerator(["--check", "--audit-extra-dir", dir]);
      expect(ok, "the coverage audit PASSED with an unscanned route present — it is a no-op").toBe(false);
      expect(output).toMatch(/NEITHER the spec nor the declared exceptions/);
      expect(output).toContain("/api/rogue-endpoint");
    });
    expect(readFileSync(SPEC, "utf8")).toBe(before);
  }, 180_000);

  it("every declared blind spot still exists — a stale exemption excuses nothing forever", () => {
    const sites = findRouteDefinitionSites(join(SERVER_ROOT, "src"), SERVER_ROOT);
    for (const blindSpot of DECLARED_BLIND_SPOTS) {
      const matched = sites.some((s) => isDeclaredBlindSpot(s.rel, s.pathLiteral) === blindSpot);
      expect(matched, `DECLARED_BLIND_SPOTS entry no longer matches any route site: ${blindSpot.file}`).toBe(true);
    }
  }, 120_000);
});
