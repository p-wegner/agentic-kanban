// @covers persistence-schema.resolve.db-location [config,boundary]
//
// Behaviour: the DB file location is resolved by a fixed precedence
//   1. env override  (DB_URL wins outright; else AGENTIC_KANBAN_DIR)
//   2. a local checkout kanban.db, if one exists
//   3. the home-dir fallback (~/.agentic-kanban/kanban.db)
// This is the mechanism behind the "a worktree dev-server transparently runs
// against a separate home-dir DB rather than the main board" footgun.
//
// Determinism: DATA_DIR is computed at module-load time, so each case sets the
// controlled inputs (env + a mocked "local kanban.db exists" flag + a fixed
// homedir) and re-imports data-dir.ts fresh via vi.resetModules(). node:fs and
// node:os are mocked, so NO real kanban.db on disk is ever read or written.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolve, join } from "node:path";

// Mutable, hoisted so the node:fs mock factory can close over it.
const fsState = vi.hoisted(() => ({ localDbExists: false }));

const HOME = resolve("/fake/home-dir");

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => HOME };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    // The only existsSync calls during data-dir module init are the two
    // "<checkout>/kanban.db" probes. Drive them off our flag; defer everything
    // else (e.g. real path checks) to the real implementation.
    existsSync: (p: import("node:fs").PathLike) =>
      String(p).endsWith("kanban.db") ? fsState.localDbExists : actual.existsSync(p),
  };
});

const ENV_KEYS = ["DB_URL", "AGENTIC_KANBAN_DIR"] as const;

async function loadDataDir() {
  vi.resetModules();
  return import("../db/data-dir.js");
}

describe("data-dir db-location resolution precedence", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    fsState.localDbExists = false;
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.resetModules();
  });

  it("DB_URL override wins over AGENTIC_KANBAN_DIR and a present local checkout db", async () => {
    process.env.DB_URL = "file:/explicit/override/custom.db";
    process.env.AGENTIC_KANBAN_DIR = resolve("/some/data/dir");
    fsState.localDbExists = true; // even with a local db AND a dir override present...

    const { getDbUrl } = await loadDataDir();
    // ...DB_URL still wins outright, verbatim.
    expect(getDbUrl()).toBe("file:/explicit/override/custom.db");
  });

  it("AGENTIC_KANBAN_DIR override wins over a present local checkout db", async () => {
    const envDir = resolve("/some/data/dir");
    process.env.AGENTIC_KANBAN_DIR = envDir;
    fsState.localDbExists = true; // a local checkout db exists, but env override outranks it

    const { getDbUrl, DATA_DIR } = await loadDataDir();
    expect(DATA_DIR).toBe(envDir);
    expect(getDbUrl()).toBe(`file:${resolve(envDir, "kanban.db")}`);
  });

  it("uses the local checkout db when it exists and no env override is set", async () => {
    fsState.localDbExists = true;

    const { getDbUrl } = await loadDataDir();
    const url = getDbUrl();
    const homeUrl = `file:${resolve(join(HOME, ".agentic-kanban"), "kanban.db")}`;

    expect(url.startsWith("file:")).toBe(true);
    expect(url.endsWith("kanban.db")).toBe(true);
    // The discriminating outcome: it resolved to the in-checkout db, NOT the
    // home-dir fallback. (A worktree WITH a checked-out db runs against itself.)
    expect(url).not.toBe(homeUrl);
    expect(url).not.toContain(".agentic-kanban");
    expect(url.toLowerCase()).toContain("server");
  });

  it("falls through to the home-dir db when no env override and no local checkout db", async () => {
    fsState.localDbExists = false; // e.g. a fresh worktree: kanban.db is gitignored, never checked out

    const { getDbUrl, DATA_DIR } = await loadDataDir();
    expect(DATA_DIR).toBe(join(HOME, ".agentic-kanban"));
    expect(getDbUrl()).toBe(`file:${resolve(join(HOME, ".agentic-kanban"), "kanban.db")}`);
  });

  it("the local-vs-home branch is decided purely by local-db existence (same env)", async () => {
    // Same (empty) env in both loads — only the existence flag differs — proving
    // existence is the deciding input for the local→home fall-through.
    fsState.localDbExists = true;
    const withLocal = (await loadDataDir()).getDbUrl();

    fsState.localDbExists = false;
    const withoutLocal = (await loadDataDir()).getDbUrl();

    const homeUrl = `file:${resolve(join(HOME, ".agentic-kanban"), "kanban.db")}`;
    expect(withLocal).not.toBe(homeUrl);
    expect(withoutLocal).toBe(homeUrl);
    expect(withLocal).not.toBe(withoutLocal);
  });
});
