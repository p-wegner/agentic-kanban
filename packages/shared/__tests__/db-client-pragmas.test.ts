import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import {
  applyPragmas,
  createClientWithPragmas,
  CONNECTION_PRAGMAS,
} from "../src/lib/db-client.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");

/**
 * Arch-review §2.3: the server DB bootstrap (`packages/server/src/db/pragmas.ts`)
 * and the MCP one (`packages/mcp-server/src/db.ts`) used to ship TWO copies of the
 * same pragma list with DIVERGENT error semantics. These tests lock the collapse:
 * one shared factory, one pragma set, and both packages provably route through it.
 */
describe("db-client — single connection-bootstrap factory", () => {
  const tempFiles: string[] = [];
  afterEach(() => {
    for (const f of tempFiles.splice(0)) {
      try {
        rmSync(f, { force: true });
        rmSync(`${f}-wal`, { force: true });
        rmSync(`${f}-shm`, { force: true });
      } catch {
        /* best-effort temp cleanup */
      }
    }
  });

  function tempDbUrl(): string {
    const path = resolve(tmpdir(), `kanban-db-client-test-${randomUUID()}.db`);
    tempFiles.push(path);
    return pathToFileURL(path).href;
  }

  it("createClientWithPragmas produces a connection with FK ON and WAL journal", async () => {
    const client = await createClientWithPragmas(tempDbUrl());
    try {
      const fk = await client.execute("PRAGMA foreign_keys");
      expect(Number((fk.rows[0] as { foreign_keys?: number }).foreign_keys)).toBe(1);

      const journal = await client.execute("PRAGMA journal_mode");
      expect(String((journal.rows[0] as { journal_mode?: string }).journal_mode).toLowerCase()).toBe(
        "wal",
      );

      const busy = await client.execute("PRAGMA busy_timeout");
      expect(Number((busy.rows[0] as { timeout?: number }).timeout)).toBe(10000);
    } finally {
      client.close();
    }
  });

  it("server bootstrap and MCP bootstrap read back the SAME pragma configuration", async () => {
    // Both packages call the shared `applyPragmas` on their own `createClient`. Simulate
    // each entrypoint's connection and assert the resulting configuration is identical —
    // the invariant the two-copy fork could silently break.
    async function bootstrapConfig() {
      const client = createClient({ url: tempDbUrl() });
      await applyPragmas(client);
      const read = async (p: string, col: string) =>
        String((await client.execute(`PRAGMA ${p}`)).rows[0]?.[col]).toLowerCase();
      const config = {
        foreign_keys: await read("foreign_keys", "foreign_keys"),
        journal_mode: await read("journal_mode", "journal_mode"),
        busy_timeout: await read("busy_timeout", "timeout"),
        synchronous: await read("synchronous", "synchronous"),
      };
      client.close();
      return config;
    }

    const serverConfig = await bootstrapConfig();
    const mcpConfig = await bootstrapConfig();
    expect(serverConfig).toEqual(mcpConfig);
    expect(serverConfig.foreign_keys).toBe("1");
    expect(serverConfig.journal_mode).toBe("wal");
  });

  it("aborts (throws) when the critical foreign_keys pragma fails", async () => {
    // The unified error policy: a failed CRITICAL pragma (foreign_keys=ON) must abort —
    // a connection without FK enforcement can never be handed out silently.
    const stub = {
      execute: vi.fn(async (sql: string) => {
        if (sql.includes("foreign_keys")) throw new Error("simulated FK failure");
        return { rows: [] };
      }),
    };
    await expect(applyPragmas(stub as never)).rejects.toThrow(/foreign_keys/);
  });

  it("tolerates (does not throw on) a failed NON-critical perf pragma", async () => {
    // journal_mode=WAL legitimately fails on a read-only DB; such a failure is logged
    // to stderr and the rest of the pragmas still apply — MCP's resilience, preserved.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stub = {
      execute: vi.fn(async (sql: string) => {
        if (sql.includes("journal_mode")) throw new Error("simulated WAL failure");
        return { rows: [] };
      }),
    };
    await expect(applyPragmas(stub as never)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("foreign_keys=ON is present and marked critical in the single pragma list", () => {
    const fk = CONNECTION_PRAGMAS.find((p) => p.pragma.includes("foreign_keys"));
    expect(fk).toBeDefined();
    expect(fk?.critical).toBe(true);
    // Every other pragma is non-critical perf/contention tuning.
    for (const p of CONNECTION_PRAGMAS) {
      if (!p.pragma.includes("foreign_keys")) expect(p.critical).toBe(false);
    }
  });

  it("server db/pragmas.ts and mcp-server db.ts both route through the shared db-client factory", () => {
    const serverPragmas = readFileSync(
      resolve(repoRoot, "packages/server/src/db/pragmas.ts"),
      "utf-8",
    );
    const mcpDb = readFileSync(resolve(repoRoot, "packages/mcp-server/src/db.ts"), "utf-8");

    // Neither file may re-declare its own pragma list any more — both delegate to the
    // ONE factory module. Assert the shared import, and that no local PRAGMA string list
    // was reintroduced.
    expect(serverPragmas).toContain("@agentic-kanban/shared/lib/db-client");
    expect(mcpDb).toContain("@agentic-kanban/shared/lib/db-client");
    expect(mcpDb).toContain("applyPragmas");
    // The MCP file must no longer own a hand-rolled PRAGMA foreign_keys=ON list.
    expect(mcpDb).not.toMatch(/PRAGMA foreign_keys=ON/);
  });
});
