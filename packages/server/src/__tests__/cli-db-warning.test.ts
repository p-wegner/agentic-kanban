import { describe, it, expect } from "vitest";
import { homeFallbackDbWarning } from "../cli/db-warning.js";

/**
 * #112: the CLI must warn loudly when it resolves to the home-fallback DB, so an
 * operator does not silently read/mutate a different database than the running
 * server. Explicitly-located DBs must stay silent.
 */
describe("homeFallbackDbWarning (#112)", () => {
  it("warns and names the path on a home-fallback DB", () => {
    const msg = homeFallbackDbWarning({
      source: "home-fallback",
      path: "C:/Users/x/.agentic-kanban/kanban.db",
      url: "file:C:/Users/x/.agentic-kanban/kanban.db",
    });
    expect(msg).not.toBeNull();
    expect(msg).toContain("C:/Users/x/.agentic-kanban/kanban.db");
    expect(msg).toContain("AGENTIC_KANBAN_DIR");
  });

  it("is silent for an explicitly-located DB", () => {
    for (const source of ["local-checkout", "AGENTIC_KANBAN_DIR", "DB_URL"]) {
      expect(
        homeFallbackDbWarning({ source, path: "/somewhere/kanban.db", url: "file:/somewhere/kanban.db" }),
      ).toBeNull();
    }
  });

  it("falls back to the url when path is null", () => {
    const msg = homeFallbackDbWarning({ source: "home-fallback", path: null, url: "libsql://remote" });
    expect(msg).toContain("libsql://remote");
  });
});
