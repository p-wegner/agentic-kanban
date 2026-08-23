// @gate:always-run — recursively walks every package's test tree; imports nothing it checks (#828).
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * A file-backed libsql handle must be CLOSED before its file is removed (#828).
 *
 * SQLite answers a write on a connection whose file has been unlinked or renamed
 * underneath it with `SQLITE_READONLY_DBMOVED` ("attempt to write a readonly
 * database"). On Windows that state is unreachable — an open file cannot be
 * deleted, so the `rmSync`/`unlinkSync` throws, the customary `catch {}` swallows
 * it, and the suite stays green. On Linux the unlink SUCCEEDS and every later
 * write through that connection fails.
 *
 * The whole test suite ran on Linux for the first time on 2026-08-23 (CI run
 * 32648937692) and `issues-routes-edge-cases.test.ts` failed in exactly this way,
 * on every one of its tests: `fileSetup()` unlinked the DB file from an `afterEach`
 * while the client it had handed to the whole `describe` was still open.
 *
 * This suite is the structural guard. It is deliberately a SOURCE SCAN rather than a
 * runtime assertion, because the runtime symptom is unreproducible on the platform we
 * develop on — a scan fails identically on both. It bites on the shape of the bug: a
 * test file that opens a `file:` libsql client AND removes something from disk, but
 * never calls `.close()`.
 *
 * Heuristic, not proof: it cannot see ORDERING (a `.close()` after the unlink still
 * passes), only PRESENCE. Presence is what was missing in all four files it found when
 * it was written, and a file that has learned to close its handles has an author who
 * thought about the lifetime at all. There is no grandfathered set — the population was
 * driven to zero in the same commit, and it must stay there.
 */

const TEST_ROOTS = [
  path.resolve(import.meta.dirname, ".."),                               // packages/server/src
  path.resolve(import.meta.dirname, "../../../shared"),                  // packages/shared
  path.resolve(import.meta.dirname, "../../../mcp-server"),              // packages/mcp-server
];

/** A `file:`-backed libsql client — `:memory:` clients own no file and cannot hit this. */
const OPENS_FILE_DB = /createClient\(\s*\{[^}]*url:\s*[`"']file:/;
/** Any removal of a path from disk. */
const REMOVES_FROM_DISK = /\b(?:unlinkSync|rmSync|rmdirSync|unlink|rm)\s*\(/;
/** Any close of anything — deliberately loose; we are checking that closing was CONSIDERED. */
const CLOSES_SOMETHING = /\.close\(\)/;

function testFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".test.ts")) out.push(full);
    }
  };
  walk(root);
  return out;
}

export function findUnclosedFileDbTeardowns(roots: readonly string[] = TEST_ROOTS): string[] {
  const offenders: string[] = [];
  for (const root of roots) {
    for (const file of testFiles(root)) {
      const src = fs.readFileSync(file, "utf-8");
      if (!OPENS_FILE_DB.test(src)) continue;
      if (!REMOVES_FROM_DISK.test(src)) continue;
      if (CLOSES_SOMETHING.test(src)) continue;
      offenders.push(path.relative(path.resolve(import.meta.dirname, "../../../.."), file).split(path.sep).join("/"));
    }
  }
  return offenders.sort();
}

describe("a file-backed libsql handle is closed before its file is removed (#828)", () => {
  it("no test file opens a file: DB and deletes from disk without ever closing a handle", () => {
    expect(findUnclosedFileDbTeardowns()).toEqual([]);
  });

  it("the scan actually looks at files — a self-check against a silently empty walk", () => {
    // If the roots stopped resolving, the check above would pass vacuously forever.
    const counted = TEST_ROOTS.reduce((n, root) => n + testFiles(root).length, 0);
    expect(counted).toBeGreaterThan(100);
  });
});
