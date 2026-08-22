import { describe, it, expect } from "vitest";
import {
  homeFallbackDbWarning,
  isWorktreeCheckout,
  probeCheckoutDb,
  type CheckoutDbState,
} from "../cli/db-warning.js";
import { join, resolve } from "node:path";

/**
 * #112: the CLI must warn when it resolves to the home-fallback DB while a
 * DIFFERENT database exists in the checkout — otherwise an operator silently
 * reads/mutates the wrong board.
 *
 * #733: but only THEN. The warning used to fire on every home-fallback
 * resolution and asserted a divergence as fact; in a checkout with no
 * packages/server/kanban.db the home path is the only database there is, and the
 * false warning talked two agents out of correct ticket writes. The
 * absent-checkout-DB case emitting NOTHING is the regression that matters here.
 */
const HOME_DB = resolve("/home/u/.agentic-kanban/kanban.db");
const homeLoc = { source: "home-fallback", path: HOME_DB, url: `file:${HOME_DB}` };

describe("homeFallbackDbWarning — the three resolution cases (#112, #733)", () => {
  it("case 1: checkout DB ABSENT in a main checkout → NO warning (#733)", () => {
    const state: CheckoutDbState = { kind: "absent", isWorktree: false };
    expect(homeFallbackDbWarning(homeLoc, state)).toBeNull();
    // Also the default: a caller that passes no state must not warn.
    expect(homeFallbackDbWarning(homeLoc)).toBeNull();
  });

  it("case 2: checkout DB PRESENT → warns and names BOTH paths", () => {
    const checkoutDb = resolve("/repo/packages/server/kanban.db");
    const msg = homeFallbackDbWarning(homeLoc, {
      kind: "present",
      path: checkoutDb,
      rejectedAsInvalid: true,
    });
    expect(msg).not.toBeNull();
    expect(msg).toContain(HOME_DB);
    expect(msg).toContain(checkoutDb);
    expect(msg).toContain("DIFFERENT database");
    expect(msg).toContain("AGENTIC_KANBAN_DIR");
    expect(msg).toContain("KANBAN_DB_URL");
    // #733: no hedged "may be" about the current resolution.
    expect(msg).not.toContain("may be reading");
  });

  it("case 3: worktree with no checkout DB → informational, and says ABSENT", () => {
    const msg = homeFallbackDbWarning(homeLoc, { kind: "absent", isWorktree: true });
    expect(msg).not.toBeNull();
    expect(msg).toContain(HOME_DB);
    expect(msg?.toLowerCase()).toContain("absent");
    expect(msg).toContain("AGENTIC_KANBAN_DIR");
  });

  it("is silent for an explicitly-located DB, whatever the checkout looks like", () => {
    for (const source of ["local-checkout", "AGENTIC_KANBAN_DIR", "DB_URL"]) {
      for (const state of [
        { kind: "absent", isWorktree: true },
        { kind: "present", path: "/repo/packages/server/kanban.db", rejectedAsInvalid: false },
      ] as CheckoutDbState[]) {
        expect(
          homeFallbackDbWarning({ source, path: "/somewhere/kanban.db", url: "file:/somewhere/kanban.db" }, state),
        ).toBeNull();
      }
    }
  });

  it("falls back to the url when path is null", () => {
    const msg = homeFallbackDbWarning(
      { source: "home-fallback", path: null, url: "libsql://remote" },
      { kind: "present", path: "/repo/packages/server/kanban.db", rejectedAsInvalid: false },
    );
    expect(msg).toContain("libsql://remote");
  });
});

describe("probeCheckoutDb", () => {
  const candidates = [resolve("/repo/packages/kanban.db"), resolve("/repo/packages/server/kanban.db")];

  it("reports ABSENT when no candidate exists on disk", () => {
    const state = probeCheckoutDb(candidates, {
      resolvedPath: HOME_DB,
      existsSync: () => false,
      isFile: () => false,
    });
    expect(state).toEqual({ kind: "absent", isWorktree: false });
  });

  it("reports PRESENT for an existing candidate, flagging a resolver-rejected one", () => {
    const present = candidates[1];
    const state = probeCheckoutDb(candidates, {
      resolvedPath: HOME_DB,
      rejectedLocalCandidates: [present],
      existsSync: (p) => resolve(p) === present,
    });
    expect(state).toEqual({ kind: "present", path: present, rejectedAsInvalid: true });
  });

  it("never reports the RESOLVED path as a divergent checkout DB", () => {
    const state = probeCheckoutDb([HOME_DB], { resolvedPath: HOME_DB, existsSync: () => true, isFile: () => false });
    expect(state.kind).toBe("absent");
  });
});

describe("isWorktreeCheckout", () => {
  const candidate = resolve("/repo/packages/server/kanban.db");
  const dotGit = join(resolve("/repo"), ".git");

  it("is true when the nearest .git is a FILE (a linked worktree)", () => {
    expect(
      isWorktreeCheckout([candidate], { existsSync: (p) => p === dotGit, isFile: (p) => p === dotGit }),
    ).toBe(true);
  });

  it("is false when the nearest .git is a DIRECTORY (a main checkout)", () => {
    expect(isWorktreeCheckout([candidate], { existsSync: (p) => p === dotGit, isFile: () => false })).toBe(false);
  });

  it("is false when no .git is found at all", () => {
    expect(isWorktreeCheckout([candidate], { existsSync: () => false, isFile: () => false })).toBe(false);
  });
});
