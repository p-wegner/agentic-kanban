/**
 * Regression test for #691:
 * The top-level /health endpoint could report green ("ok") even when the
 * shared package's dist output was missing — so a restarted server looked
 * healthy while every DB-backed API route failed with ERR_MODULE_NOT_FOUND
 * for @agentic-kanban/shared/dist/*. Monitors polling /health saw UP and
 * never noticed the board was actually broken for all real operations.
 *
 * The fix: /health must fail (503, status "degraded") when a critical
 * dependency — in particular the shared dist — is missing. A passing
 * DB-backed route is also exercised to prove the smoke path goes beyond
 * the bare /health liveness check.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { createHealthRoute } from "../routes/health.js";
import { createProjectsRoute } from "../routes/projects.js";
import { createMockSessionManager } from "./helpers/mocks.js";
import { createTestApp } from "./helpers/test-app.js";

const TEST_DIR = join(tmpdir(), "health-route-deps-" + process.pid);

function touch(relPath: string) {
  const full = join(TEST_DIR, relPath);
  mkdirSync(full.replace(/[/\\][^/\\]+$/, ""), { recursive: true });
  writeFileSync(full, "");
}

function seedAllDeps() {
  touch("packages/shared/drizzle/meta/_journal.json");
  touch("packages/server/node_modules/drizzle-orm/package.json");
  touch("packages/server/node_modules/hono/package.json");
  touch("packages/shared/dist/index.js");
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("/health is dependency-aware (#691)", () => {
  it("reports ok=true / 200 when all deps (incl. shared dist) are present", async () => {
    seedAllDeps();
    const app = new Hono();
    app.route("/api/health", createHealthRoute(TEST_DIR));

    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; ok: boolean };
    expect(body.ok).toBe(true);
    expect(body.status).toBe("ok");
  });

  it("reports 503 / degraded when shared dist is missing — NOT green", async () => {
    // Everything present EXCEPT the shared dist — exactly the #691 failure mode.
    touch("packages/shared/drizzle/meta/_journal.json");
    touch("packages/server/node_modules/drizzle-orm/package.json");
    touch("packages/server/node_modules/hono/package.json");

    const app = new Hono();
    app.route("/api/health", createHealthRoute(TEST_DIR));

    const res = await app.request("/api/health");
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      status: string;
      ok: boolean;
      checks: Array<{ name: string; ok: boolean; detail: string }>;
    };
    expect(body.ok).toBe(false);
    expect(body.status).toBe("degraded");
    const dist = body.checks.find((c) => c.name === "shared-dist");
    expect(dist?.ok).toBe(false);
    expect(dist?.detail).toContain("pnpm --filter @agentic-kanban/shared build");
  });
});

describe("DB-backed smoke check goes beyond /health (#691)", () => {
  it("GET /api/projects returns a list from the DB", async () => {
    const { app } = createTestApp((a, db) => {
      a.route("/api/projects", createProjectsRoute(db, { getSessionManager: () => createMockSessionManager() }));
    });

    const res = await app.request("/api/projects");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });
});
