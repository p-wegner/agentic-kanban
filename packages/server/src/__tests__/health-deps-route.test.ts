import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkHealthDeps } from "../services/health-deps.service.js";

const TEST_DIR = join(tmpdir(), "health-deps-test-" + process.pid);

function touch(relPath: string) {
  const full = join(TEST_DIR, relPath);
  mkdirSync(full.replace(/[/\\][^/\\]+$/, ""), { recursive: true });
  writeFileSync(full, "");
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("checkHealthDeps", () => {
  it("returns ok=true when all files exist", () => {
    touch("packages/shared/drizzle/meta/_journal.json");
    touch("node_modules/drizzle-orm/package.json");
    touch("node_modules/hono/package.json");
    touch("packages/shared/dist/index.js");

    const result = checkHealthDeps(TEST_DIR);

    expect(result.ok).toBe(true);
    expect(result.checks).toHaveLength(4);
    expect(result.checks.every((c) => c.ok)).toBe(true);
  });

  it("returns ok=false when drizzle journal is missing, with git-restore hint", () => {
    touch("node_modules/drizzle-orm/package.json");
    touch("node_modules/hono/package.json");
    touch("packages/shared/dist/index.js");

    const result = checkHealthDeps(TEST_DIR);

    expect(result.ok).toBe(false);
    const journal = result.checks.find((c) => c.name === "drizzle-journal");
    expect(journal?.ok).toBe(false);
    expect(journal?.detail).toContain("git restore");
    expect(journal?.detail).toContain("_journal.json");
  });

  it("returns ok=false when drizzle-orm is missing, with pnpm install hint", () => {
    touch("packages/shared/drizzle/meta/_journal.json");
    touch("node_modules/hono/package.json");
    touch("packages/shared/dist/index.js");

    const result = checkHealthDeps(TEST_DIR);

    expect(result.ok).toBe(false);
    const drizzle = result.checks.find((c) => c.name === "node_modules/drizzle-orm");
    expect(drizzle?.ok).toBe(false);
    expect(drizzle?.detail).toContain("pnpm install");
  });

  it("returns ok=false when hono is missing, with pnpm install hint", () => {
    touch("packages/shared/drizzle/meta/_journal.json");
    touch("node_modules/drizzle-orm/package.json");
    touch("packages/shared/dist/index.js");

    const result = checkHealthDeps(TEST_DIR);

    expect(result.ok).toBe(false);
    const hono = result.checks.find((c) => c.name === "node_modules/hono");
    expect(hono?.ok).toBe(false);
    expect(hono?.detail).toContain("pnpm install");
  });

  it("returns ok=false when shared dist is missing, with build hint", () => {
    touch("packages/shared/drizzle/meta/_journal.json");
    touch("node_modules/drizzle-orm/package.json");
    touch("node_modules/hono/package.json");

    const result = checkHealthDeps(TEST_DIR);

    expect(result.ok).toBe(false);
    const dist = result.checks.find((c) => c.name === "shared-dist");
    expect(dist?.ok).toBe(false);
    expect(dist?.detail).toContain("pnpm --filter @agentic-kanban/shared build");
  });

  it("always returns all 4 named checks even when all fail", () => {
    const result = checkHealthDeps(TEST_DIR);

    expect(result.ok).toBe(false);
    expect(result.checks).toHaveLength(4);
    expect(result.checks.map((c) => c.name)).toEqual([
      "drizzle-journal",
      "node_modules/drizzle-orm",
      "node_modules/hono",
      "shared-dist",
    ]);
  });

  it("passing checks include the resolved file path in detail", () => {
    touch("packages/shared/drizzle/meta/_journal.json");
    touch("node_modules/drizzle-orm/package.json");
    touch("node_modules/hono/package.json");
    touch("packages/shared/dist/index.js");

    const result = checkHealthDeps(TEST_DIR);

    for (const check of result.checks) {
      expect(check.detail).toContain(TEST_DIR);
    }
  });
});
