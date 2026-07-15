// @covers persistence-schema.resolve.db-location [config,boundary]
//
// The shared DB-location resolver is the SINGLE source of precedence the HTTP
// server and the MCP server both use (#962). Before it existed the two diverged:
// the server let AGENTIC_KANBAN_DIR win over an in-checkout dev DB, while the MCP
// server let a present dev DB outrank AGENTIC_KANBAN_DIR — so with the env var set
// and a dev DB on disk they silently opened DIFFERENT databases. These tests pin
// the unified precedence (explicit env override ALWAYS wins) and the split-brain
// reproduction (server-shaped vs MCP-shaped candidates → identical resolution).

import { describe, it, expect } from "vitest";
import { resolve, join } from "node:path";
import { resolveDbLocation } from "../src/lib/db-path.js";

const HOME = resolve("/fake/home-dir");

// Server's in-checkout candidates (packages/server/{,src/db/} → packages/server/kanban.db)
const SERVER_CANDIDATES = [resolve("/repo/packages/server/kanban.db")];
// MCP's in-checkout candidate (packages/mcp-server/... → packages/server/kanban.db)
const MCP_CANDIDATES = [resolve("/repo/packages/server/kanban.db")];

function base(overrides: Partial<Parameters<typeof resolveDbLocation>[0]> = {}) {
  return {
    env: {} as Record<string, string | undefined>,
    homeDir: HOME,
    existsSync: () => false,
    ...overrides,
  };
}

describe("resolveDbLocation precedence", () => {
  it("DB_URL wins outright over AGENTIC_KANBAN_DIR and a present dev DB", () => {
    const loc = resolveDbLocation(
      base({
        env: { DB_URL: "file:/explicit/custom.db", AGENTIC_KANBAN_DIR: resolve("/data/dir") },
        existsSync: () => true,
        localDbCandidates: SERVER_CANDIDATES,
      }),
    );
    expect(loc.source).toBe("DB_URL");
    expect(loc.url).toBe("file:/explicit/custom.db");
    expect(loc.path).toBe("/explicit/custom.db");
  });

  it("a Windows file:///C:/... DB_URL resolves to the real drive path, not a bogus <drive>:/C:/... nesting", () => {
    const loc = resolveDbLocation(base({ env: { DB_URL: "file:///C:/Users/pete/kanban.db" } }));
    expect(loc.source).toBe("DB_URL");
    expect(loc.path).toBe("C:\\Users\\pete\\kanban.db");
    expect(loc.dir).toBe("C:\\Users\\pete");
  });

  it("a non-file DB_URL has no on-disk path/dir", () => {
    const loc = resolveDbLocation(base({ env: { DB_URL: "libsql://remote.example/db" } }));
    expect(loc.source).toBe("DB_URL");
    expect(loc.url).toBe("libsql://remote.example/db");
    expect(loc.path).toBeNull();
    expect(loc.dir).toBeNull();
  });

  it("AGENTIC_KANBAN_DIR wins over a present in-checkout dev DB (the #962 fix)", () => {
    const envDir = resolve("/data/dir");
    const loc = resolveDbLocation(
      base({
        env: { AGENTIC_KANBAN_DIR: envDir },
        existsSync: () => true, // a dev DB IS on disk, but the env override outranks it
        localDbCandidates: SERVER_CANDIDATES,
      }),
    );
    expect(loc.source).toBe("AGENTIC_KANBAN_DIR");
    expect(loc.url).toBe(`file:${resolve(envDir, "kanban.db")}`);
    expect(loc.dir).toBe(envDir);
  });

  it("uses the in-checkout dev DB when it exists and no env override is set", () => {
    const loc = resolveDbLocation(
      base({ existsSync: () => true, localDbCandidates: SERVER_CANDIDATES }),
    );
    expect(loc.source).toBe("local-checkout");
    expect(loc.path).toBe(SERVER_CANDIDATES[0]);
  });

  it("falls back to the home-dir DB when no env override and no dev DB", () => {
    const loc = resolveDbLocation(
      base({ existsSync: () => false, localDbCandidates: SERVER_CANDIDATES }),
    );
    expect(loc.source).toBe("home-fallback");
    expect(loc.path).toBe(resolve(join(HOME, ".agentic-kanban", "kanban.db")));
    expect(loc.dir).toBe(resolve(join(HOME, ".agentic-kanban")));
  });

  // The split-brain reproduction: same env + same on-disk state, resolved once with
  // the server's candidates and once with the MCP server's candidates. They MUST
  // agree. With AGENTIC_KANBAN_DIR set and a dev DB present, the old MCP resolver
  // returned the dev DB while the server returned the env dir — different databases.
  it("server-shaped and MCP-shaped resolution agree when AGENTIC_KANBAN_DIR is set", () => {
    const env = { AGENTIC_KANBAN_DIR: resolve("/shared/data") };
    const existsSync = () => true; // dev DB present in the monorepo
    const server = resolveDbLocation(base({ env, existsSync, localDbCandidates: SERVER_CANDIDATES }));
    const mcp = resolveDbLocation(base({ env, existsSync, localDbCandidates: MCP_CANDIDATES }));
    expect(mcp.url).toBe(server.url);
    expect(mcp.source).toBe(server.source);
    expect(server.source).toBe("AGENTIC_KANBAN_DIR");
  });
});
