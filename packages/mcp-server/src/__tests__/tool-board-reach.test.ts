/**
 * #605 — the MCP tools have exactly TWO sanctioned ways to reach the board, and this
 * pins both.
 *
 * 1. The DEPS seam (`register(server, deps: ToolDeps = prodDeps)`), which is what makes a
 *    tool unit-testable without spawning the server over stdio. 27 tools instead imported
 *    the `db`/`schema` module singletons directly; not one of the 30 tool tests mocked
 *    `../db`, so those tools were effectively untestable.
 * 2. HTTP to the board's REST API, for state that lives in the SERVER's memory (a running
 *    session, a merge lock, a compose stack). A DB-reading tool cannot see that state, so
 *    writing it from a tool would silently diverge from what the board believes.
 *
 * The first rule is a zero-tolerance scanner. The second is an allowlist: writes to
 * `workspaces.status` / `sessions` must go over HTTP, so a tool that writes them from the
 * DB fails here and has to justify itself by name.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TOOLS_DIR = join(import.meta.dirname, "..", "tools");

function toolFiles(): string[] {
  return readdirSync(TOOLS_DIR).filter(f => f.endsWith(".ts") && f !== "deps.ts");
}

describe("MCP board reach (#605)", () => {
  it("no tool imports the db/schema module singletons — only tools/deps.ts may", () => {
    const offenders = toolFiles().filter(f =>
      /^import\s+\{[^}]*\}\s+from\s+"\.\.\/db\.js";/m.test(readFileSync(join(TOOLS_DIR, f), "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("every tool that touches the DB takes it through the ToolDeps seam", () => {
    const offenders: string[] = [];
    for (const f of toolFiles()) {
      const src = readFileSync(join(TOOLS_DIR, f), "utf8");
      // A file that never queries is an HTTP-style tool — nothing to check. Both seam
      // spellings count: destructuring `const { db } = deps` and reaching `deps.db`
      // directly (which the helpers that take a whole `deps` do).
      const queries = /(?:^|[^.\w])db\.(?:select|insert|update|delete)\(/.test(src);
      const throughSeam = /const \{[^}]*\bdb\b[^}]*\} = deps;/.test(src) || /\bdeps\.db\b/.test(src);
      if (queries && !throughSeam) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  it("session/workspace-status WRITES go over HTTP, not straight into the DB", () => {
    // The board holds the live session and merge state in memory; a direct DB write is
    // invisible to it. These tools delegate to the REST endpoints that own that state.
    const HTTP_ONLY_WRITERS = ["launch-workspace.ts", "relaunch-workspace.ts", "review-workspace.ts", "merge-workspace.ts", "stop-workspace.ts", "start-workspace.ts", "close-workspace.ts", "delete-workspace.ts"];
    // LIVE state only. `backfill_friction` writes `sessions.stats` from stored messages —
    // an analysis column the server holds no opinion about — so the rule is about the
    // lifecycle fields (`status`, `pid`), not about touching those tables at all.
    const LIVE_WRITE = /\.update\(schema\.(?:sessions|workspaces)\)[\s\S]{0,300}?\.set\(\{[\s\S]{0,200}?\b(?:status|pid)\s*:/;
    const offenders: string[] = [];
    for (const f of toolFiles()) {
      if (HTTP_ONLY_WRITERS.includes(f)) continue;
      const src = readFileSync(join(TOOLS_DIR, f), "utf8");
      if (LIVE_WRITE.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
