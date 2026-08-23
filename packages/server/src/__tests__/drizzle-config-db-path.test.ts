import { describe, expect, it } from "vitest";
import drizzleConfig from "../../drizzle.config.js";
import { getDbUrl } from "../db/data-dir.js";

/**
 * `drizzle.config.ts` used to hardcode a CWD-relative `file:kanban.db`, so drizzle-kit
 * was the one tool that ignored the shared resolver: running it from `packages/server`
 * CREATED a schema-only `packages/server/kanban.db` which then shadowed the real
 * database for every later process (the board reads as empty). The config must resolve
 * through the same single source of truth as the server, CLI and MCP server.
 */
describe("drizzle.config.ts DB target", () => {
  it("resolves its DB url through the shared resolver, not a hardcoded relative path", () => {
    expect("dbCredentials" in drizzleConfig).toBe(true);
    if (!("dbCredentials" in drizzleConfig)) throw new Error("drizzle.config.ts declares no dbCredentials");
    const url = (drizzleConfig.dbCredentials as { url: string }).url;
    expect(url).toBe(getDbUrl());
    // A relative `file:kanban.db` is exactly the shape that minted the shadow DB.
    expect(url.startsWith("file:kanban.db")).toBe(false);
  });
});
