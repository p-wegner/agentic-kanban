import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("MCP DB connection pragmas", () => {
  const originalDbUrl = process.env.DB_URL;

  afterEach(() => {
    if (originalDbUrl === undefined) {
      delete process.env.DB_URL;
    } else {
      process.env.DB_URL = originalDbUrl;
    }
    vi.resetModules();
  });

  it("enables SQLite foreign key enforcement on startup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ak-mcp-db-"));
    process.env.DB_URL = join(dir, "kanban.db");
    vi.resetModules();

    const { rawClient } = await import("../db.js");
    const result = await rawClient.execute("PRAGMA foreign_keys");

    expect(Number(result.rows[0]?.foreign_keys ?? 0)).toBe(1);
  });
});
