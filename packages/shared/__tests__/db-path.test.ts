// @covers persistence-schema.resolve.db-location [config,boundary]
//
// The shared DB-location resolver is the SINGLE source of precedence the HTTP
// server and the MCP server both use (#962). Before it existed the two diverged:
// the server let AGENTIC_KANBAN_DIR win over an in-checkout dev DB, while the MCP
// server let a present dev DB outrank AGENTIC_KANBAN_DIR — so with the env var set
// and a dev DB on disk they silently opened DIFFERENT databases. These tests pin
// the unified precedence (explicit env override ALWAYS wins) and the split-brain
// reproduction (server-shaped vs MCP-shaped candidates → identical resolution).

import { describe, it, expect, afterAll } from "vitest";
import { resolve, join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { resolveDbLocation, sqliteHasBoardContent } from "../src/lib/db-path.js";

const HOME = resolve("/fake/home-dir");

// Server's in-checkout candidates (packages/server/{,src/db/} → packages/server/kanban.db)
const SERVER_CANDIDATES = [resolve("/repo/packages/server/kanban.db")];
// MCP's in-checkout candidate (packages/mcp-server/... → packages/server/kanban.db)
const MCP_CANDIDATES = [resolve("/repo/packages/server/kanban.db")];

// A real DB is reliably above the resolver's size floor; tests that stub
// `existsSync: () => true` for a candidate need a matching statSync so the
// candidate also passes the "looks like a real database" check (#165).
const VALID_DB_STAT = () => ({ size: 1_000_000 });

function base(overrides: Partial<Parameters<typeof resolveDbLocation>[0]> = {}) {
  return {
    env: {} as Record<string, string | undefined>,
    homeDir: HOME,
    existsSync: () => false,
    statSync: VALID_DB_STAT,
    // Hermetic by default: the real probe would open (nonexistent) fake paths. Tests
    // that care about the content check inject their own.
    hasBoardContent: () => true,
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

  it("redirects to a per-process throwaway DB under a test runner with no explicit override (#231)", () => {
    // The pre-merge verify gate's vitest workers used to fall through to the user's LIVE
    // home-fallback DB, contend with the running server for locks, and write junk into it.
    const loc = resolveDbLocation(base({ env: { VITEST: "true" } }));
    expect(loc.source).toBe("test-throwaway");
    expect(loc.path).toContain(`agentic-kanban-vitest-${process.pid}`);
    expect(loc.path?.replace(/\\/g, "/")).not.toContain(".agentic-kanban");
  });

  it("test-runner redirect also outranks a present in-checkout dev DB (#231)", () => {
    const loc = resolveDbLocation(
      base({ env: { NODE_ENV: "test" }, existsSync: () => true, localDbCandidates: SERVER_CANDIDATES }),
    );
    expect(loc.source).toBe("test-throwaway");
  });

  it("an explicit override still wins under a test runner — tests can pin a DB deliberately (#231)", () => {
    const envDir = resolve("/gate/throwaway");
    const loc = resolveDbLocation(base({ env: { VITEST: "true", AGENTIC_KANBAN_DIR: envDir } }));
    expect(loc.source).toBe("AGENTIC_KANBAN_DIR");
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

// #165: a probe/CLI read-path must never let an empty or tiny in-checkout file
// win rule 3 — the resolver never opens/creates anything itself, but returning
// `local-checkout` for a stub is what makes the caller open (and permanently
// adopt) it. A present-but-invalid candidate must fall through to home-fallback.
describe("resolveDbLocation rule 3 never adopts an empty/invalid local file (#165)", () => {
  it("falls through to home-fallback when the local candidate is a zero-byte stub", () => {
    const loc = resolveDbLocation(
      base({
        existsSync: () => true,
        statSync: () => ({ size: 0 }),
        localDbCandidates: SERVER_CANDIDATES,
      }),
    );
    expect(loc.source).toBe("home-fallback");
    expect(loc.path).toBe(resolve(join(HOME, ".agentic-kanban", "kanban.db")));
  });

  it("falls through to home-fallback when the local candidate is below the valid-DB size floor", () => {
    const loc = resolveDbLocation(
      base({
        existsSync: () => true,
        statSync: () => ({ size: 4096 }), // the reproduced #165 stub was ~4KB
        localDbCandidates: SERVER_CANDIDATES,
      }),
    );
    expect(loc.source).toBe("home-fallback");
  });

  it("falls through to home-fallback when statSync throws (e.g. a race with deletion)", () => {
    const loc = resolveDbLocation(
      base({
        existsSync: () => true,
        statSync: () => {
          throw new Error("ENOENT");
        },
        localDbCandidates: SERVER_CANDIDATES,
      }),
    );
    expect(loc.source).toBe("home-fallback");
  });

  it("still adopts a local candidate that exists AND is a plausible real DB", () => {
    const loc = resolveDbLocation(
      base({
        existsSync: () => true,
        statSync: () => ({ size: 1_000_000 }),
        localDbCandidates: SERVER_CANDIDATES,
      }),
    );
    expect(loc.source).toBe("local-checkout");
    expect(loc.path).toBe(SERVER_CANDIDATES[0]);
  });

  it("skips an invalid first candidate and falls through to a valid second candidate", () => {
    const stubCandidate = resolve("/repo/packages/server/kanban.db");
    const realCandidate = resolve("/repo/packages/server/src/db/kanban.db");
    const sizes = new Map([
      [stubCandidate, 0],
      [realCandidate, 1_000_000],
    ]);
    const loc = resolveDbLocation(
      base({
        existsSync: () => true,
        statSync: (p: string) => ({ size: sizes.get(p) ?? 0 }),
        localDbCandidates: [stubCandidate, realCandidate],
      }),
    );
    expect(loc.source).toBe("local-checkout");
    expect(loc.path).toBe(realCandidate);
  });

  // The floor is a heuristic, and the stub that actually caused the incident was ~700 KB —
  // far ABOVE it — because `drizzle-kit` ran every migration into it. So the rejection must
  // not be silent: a rejected candidate is reported so the startup log can name the file.
  it("REPORTS a rejected stub candidate instead of skipping it silently", () => {
    const loc = resolveDbLocation(
      base({
        existsSync: () => true,
        statSync: () => ({ size: 4096 }),
        localDbCandidates: SERVER_CANDIDATES,
      }),
    );
    expect(loc.source).toBe("home-fallback");
    expect(loc.rejectedLocalCandidates).toEqual([SERVER_CANDIDATES[0]]);
  });

  it("reports NO rejected candidates on a clean resolution", () => {
    const adopted = resolveDbLocation(base({ existsSync: () => true, localDbCandidates: SERVER_CANDIDATES }));
    expect(adopted.rejectedLocalCandidates).toEqual([]);
    const home = resolveDbLocation(base({ existsSync: () => false, localDbCandidates: SERVER_CANDIDATES }));
    expect(home.rejectedLocalCandidates).toEqual([]);
    const envDir = resolveDbLocation(base({ env: { AGENTIC_KANBAN_DIR: resolve("/data/dir") }, existsSync: () => true, localDbCandidates: SERVER_CANDIDATES }));
    expect(envDir.rejectedLocalCandidates).toEqual([]);
  });

  it("resolveDbLocation never calls fs functions that create/open a file (pure path decision)", () => {
    // A dedicated assertion that the resolver itself never touches anything but
    // the injected existsSync/statSync — no write/open API is imported or called.
    const calls: string[] = [];
    resolveDbLocation(
      base({
        existsSync: (p: string) => {
          calls.push(`exists:${p}`);
          return false;
        },
        statSync: (p: string) => {
          calls.push(`stat:${p}`);
          return { size: 0 };
        },
        localDbCandidates: SERVER_CANDIDATES,
      }),
    );
    expect(calls).toEqual([`exists:${SERVER_CANDIDATES[0]}`]);
  });
});

// #663 — the size floor cannot see this: a leftover in-checkout DB that has been fully
// MIGRATED but holds zero rows is ~850 KB, clears the floor, and is adopted, silently
// shadowing the real board. Only CONTENT separates the two.
describe("resolveDbLocation content probe (#663)", () => {
  it("REJECTS a size-passing but EMPTY in-checkout DB and falls through to home-fallback", () => {
    const loc = resolveDbLocation(
      base({
        existsSync: () => true,
        statSync: () => ({ size: 847_872 }), // the real stray was 847 KB
        hasBoardContent: () => false,
        localDbCandidates: SERVER_CANDIDATES,
      }),
    );
    expect(loc.source).toBe("home-fallback");
    expect(loc.rejectedLocalCandidates).toEqual([SERVER_CANDIDATES[0]]);
  });

  it("still ADOPTS a populated in-checkout DB (the normal dev-checkout case)", () => {
    const loc = resolveDbLocation(
      base({
        existsSync: () => true,
        hasBoardContent: () => true,
        localDbCandidates: SERVER_CANDIDATES,
      }),
    );
    expect(loc.source).toBe("local-checkout");
    expect(loc.path).toBe(SERVER_CANDIDATES[0]);
    expect(loc.rejectedLocalCandidates).toEqual([]);
  });

  it("skips an EMPTY first candidate and adopts a populated second one", () => {
    const emptyCandidate = resolve("/repo/packages/server/kanban.db");
    const realCandidate = resolve("/repo/packages/server/src/db/kanban.db");
    const loc = resolveDbLocation(
      base({
        existsSync: () => true,
        hasBoardContent: (p: string) => p === realCandidate,
        localDbCandidates: [emptyCandidate, realCandidate],
      }),
    );
    expect(loc.source).toBe("local-checkout");
    expect(loc.path).toBe(realCandidate);
    expect(loc.rejectedLocalCandidates).toEqual([emptyCandidate]);
  });

  it("an explicit env override still wins over the probe (never probes at all)", () => {
    let probed = false;
    const loc = resolveDbLocation(
      base({
        env: { AGENTIC_KANBAN_DIR: resolve("/data/dir") },
        existsSync: () => true,
        hasBoardContent: () => {
          probed = true;
          return false;
        },
        localDbCandidates: SERVER_CANDIDATES,
      }),
    );
    expect(loc.source).toBe("AGENTIC_KANBAN_DIR");
    expect(probed).toBe(false);
  });

  it("the size floor is checked BEFORE the probe — a stub is never opened", () => {
    let probed = false;
    const loc = resolveDbLocation(
      base({
        existsSync: () => true,
        statSync: () => ({ size: 4096 }),
        hasBoardContent: () => {
          probed = true;
          return true;
        },
        localDbCandidates: SERVER_CANDIDATES,
      }),
    );
    expect(loc.source).toBe("home-fallback");
    expect(probed).toBe(false);
  });
});

describe("sqliteHasBoardContent", () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "db-path-probe-"));

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeDb(name: string, seed: (db: DatabaseSync) => void): string {
    const file = join(tmpRoot, name);
    const db = new DatabaseSync(file);
    db.exec("create table projects (id text primary key, name text)");
    seed(db);
    db.close();
    return file;
  }

  it("is false for a migrated-but-EMPTY database (the #663 stray)", () => {
    const file = makeDb("empty.db", () => {});
    expect(sqliteHasBoardContent(file)).toBe(false);
  });

  it("is true for a database holding at least one project", () => {
    const file = makeDb("populated.db", (db) => {
      db.prepare("insert into projects (id, name) values (?, ?)").run("p1", "board");
    });
    expect(sqliteHasBoardContent(file)).toBe(true);
  });

  // Fails OPEN by design: rejecting on a failed probe would route a healthy-but-locked
  // dev DB to the home fallback and split the board in two.
  it("is true when the file cannot be probed at all (missing / not a database)", () => {
    expect(sqliteHasBoardContent(join(tmpRoot, "does-not-exist.db"))).toBe(true);
    const notADb = join(tmpRoot, "garbage.db");
    writeFileSync(notADb, "this is not a sqlite file");
    expect(sqliteHasBoardContent(notADb)).toBe(true);
  });

  it("is true for a database with no `projects` table at all (predates the schema)", () => {
    const file = join(tmpRoot, "no-projects.db");
    const db = new DatabaseSync(file);
    db.exec("create table something_else (id text)");
    db.close();
    expect(sqliteHasBoardContent(file)).toBe(true);
  });

  it("does not CREATE a database it probes (read-only)", () => {
    const missing = join(tmpRoot, "must-not-be-created.db");
    sqliteHasBoardContent(missing);
    expect(existsSync(missing)).toBe(false);
  });
});

// #803 — a DB location that is the STRINGIFIED form of a missing value.
//
// Found as a real artifact: `packages/shared/undefined`, a 12 KB / 3-page SQLite
// database sitting untracked in the checkout. Nothing "wrote a bad path" on
// purpose — a shell or JS template interpolated an unset variable, producing the
// literal text "undefined", and the layer below happily accepted it: a `file:`
// open CREATES its target. So the failure is silent and inverted — instead of an
// error you get a working, empty database, and every read reports an empty board.
//
// The resolver is the only place that can notice, because `DB_URL` is used
// VERBATIM (see precedence rule 1). These pin the rejection.
describe("placeholder env values (#803)", () => {
  const PLACEHOLDERS = ["undefined", "null", "NaN", "[object Object]"];

  for (const value of PLACEHOLDERS) {
    it(`refuses DB_URL="${value}" instead of opening (and creating) it`, () => {
      expect(() => resolveDbLocation(base({ env: { DB_URL: value } })))
        .toThrow(/stringified form of a missing value/);
    });

    it(`refuses KANBAN_DB_URL="${value}"`, () => {
      expect(() => resolveDbLocation(base({ env: { KANBAN_DB_URL: value } })))
        .toThrow(/KANBAN_DB_URL/);
    });

    it(`refuses AGENTIC_KANBAN_DIR="${value}"`, () => {
      expect(() => resolveDbLocation(base({ env: { AGENTIC_KANBAN_DIR: value } })))
        .toThrow(/AGENTIC_KANBAN_DIR/);
    });
  }

  it("names the offending variable so the message is actionable", () => {
    expect(() => resolveDbLocation(base({ env: { DB_URL: "undefined" } })))
      .toThrow(/^DB_URL is set to the literal string "undefined"/);
  });

  it("tolerates surrounding whitespace, which a shell interpolation leaves behind", () => {
    expect(() => resolveDbLocation(base({ env: { DB_URL: "  undefined  " } })))
      .toThrow(/stringified form of a missing value/);
  });

  // The rejection must be narrow: these are all legitimate locations that merely
  // CONTAIN a placeholder word, and turning them away would be a worse bug than
  // the one being fixed.
  it("does not reject a real path that merely contains the word", () => {
    const loc = resolveDbLocation(base({ env: { DB_URL: "file:/data/undefined-board/kanban.db" } }));
    expect(loc.source).toBe("DB_URL");
    expect(loc.path).toContain("undefined-board");
  });

  it("does not reject a remote libsql URL", () => {
    const loc = resolveDbLocation(base({ env: { DB_URL: "libsql://board.example.com" } }));
    expect(loc.source).toBe("DB_URL");
    expect(loc.path).toBeNull();
  });

  it("an UNSET variable still falls through to the normal precedence", () => {
    const loc = resolveDbLocation(base({ env: {} }));
    expect(loc.source).not.toBe("DB_URL");
  });
});
