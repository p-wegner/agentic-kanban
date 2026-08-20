import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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
    process.env.DB_URL = pathToFileURL(join(dir, "kanban.db")).href;
    vi.resetModules();

    const { rawClient } = await import("../db.js");
    const result = await rawClient.execute("PRAGMA foreign_keys");

    expect(Number(result.rows[0]?.foreign_keys ?? 0)).toBe(1);
  });

  it("fails module init loudly when PRAGMA foreign_keys does not take (#955)", async () => {
    process.env.DB_URL = "file:unused.db";
    vi.resetModules();
    vi.doMock("@libsql/client", () => ({
      createClient: () => ({
        execute: async (sql: string) => {
          if (sql === "PRAGMA foreign_keys") {
            return { rows: [{ foreign_keys: 0 }] };
          }
          return { rows: [] };
        },
      }),
    }));

    await expect(import("../db.js")).rejects.toThrow(/PRAGMA foreign_keys is OFF/);
    vi.doUnmock("@libsql/client");
  });

  it("logs which pragma failed instead of swallowing it, and still asserts FKs (#955)", async () => {
    process.env.DB_URL = "file:unused.db";
    vi.resetModules();
    vi.doMock("@libsql/client", () => ({
      createClient: () => ({
        execute: async (sql: string) => {
          if (sql === "PRAGMA journal_mode=WAL") {
            throw new Error("cannot change into wal mode");
          }
          if (sql === "PRAGMA foreign_keys") {
            return { rows: [{ foreign_keys: 1 }] };
          }
          return { rows: [] };
        },
      }),
    }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(import("../db.js")).resolves.toBeDefined();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("PRAGMA journal_mode=WAL failed"),
    );
    warnSpy.mockRestore();
    vi.doUnmock("@libsql/client");
  });
});
