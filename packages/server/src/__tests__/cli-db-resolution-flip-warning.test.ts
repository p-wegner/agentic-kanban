import { describe, it, expect } from "vitest";
import { dbResolutionFlipWarning } from "../cli/last-resolved-db.js";

/**
 * #165: the CLI must warn loudly when a subcommand resolves to a DIFFERENT
 * database than the immediately preceding invocation — the exact symptom that
 * let an empty shadow packages/server/kanban.db go unnoticed across several
 * calls in one session before this fix.
 */
describe("dbResolutionFlipWarning (#165)", () => {
  it("is silent on the very first invocation (no prior recorded path)", () => {
    const msg = dbResolutionFlipWarning(
      { source: "home-fallback", path: "/home/.agentic-kanban/kanban.db", url: "file:/home/.agentic-kanban/kanban.db" },
      null,
    );
    expect(msg).toBeNull();
  });

  it("is silent when resolution matches the last recorded path", () => {
    const msg = dbResolutionFlipWarning(
      { source: "local-checkout", path: "/repo/packages/server/kanban.db", url: "file:/repo/packages/server/kanban.db" },
      "/repo/packages/server/kanban.db",
    );
    expect(msg).toBeNull();
  });

  it("warns loudly and names both paths when resolution flips", () => {
    const msg = dbResolutionFlipWarning(
      { source: "local-checkout", path: "/repo/packages/server/kanban.db", url: "file:/repo/packages/server/kanban.db" },
      "/home/.agentic-kanban/kanban.db",
    );
    expect(msg).not.toBeNull();
    expect(msg).toContain("/home/.agentic-kanban/kanban.db");
    expect(msg).toContain("/repo/packages/server/kanban.db");
    expect(msg).toContain("AGENTIC_KANBAN_DIR");
  });

  it("falls back to the url for the current side when path is null", () => {
    const msg = dbResolutionFlipWarning(
      { source: "DB_URL", path: null, url: "libsql://remote" },
      "/home/.agentic-kanban/kanban.db",
    );
    expect(msg).toContain("libsql://remote");
  });
});
