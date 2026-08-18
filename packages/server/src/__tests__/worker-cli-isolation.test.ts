// @gate:always-run — walks the server src import graph from the worker CLI entry; no import edge to it (#647).
// The `agentic-kanban-worker` binary exists so a worker machine can run the
// daemon WITHOUT the board's command tree — no database layer, no server
// services. That promise is an import-graph property, and import graphs rot
// silently: one convenient `import { thing } from "../services/…"` re-couples
// everything and nothing visibly breaks. So walk the graph and assert it.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SERVER_SRC = resolve(__dirname, "..");
const ENTRY = resolve(SERVER_SRC, "worker/worker-cli.ts");

/** Modules whose presence in the graph means the board layer got pulled in. */
const FORBIDDEN_LOCAL = [
  "src/db/",
  "src/services/worker-fleet.service",
  "src/services/agent-remote.service",
  "src/services/git-http.service",
  "src/repositories/",
  "src/routes/",
  "src/startup/",
];

/** npm packages a worker must never need at runtime. */
const FORBIDDEN_PACKAGES = [
  "drizzle-orm",
  "@libsql/client",
  "@modelcontextprotocol/sdk",
  "@anthropic-ai/claude-agent-sdk",
  "hono",
  "ts-morph",
];

function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  // Static `import ... from "x"` / `export ... from "x"` plus dynamic import("x").
  const specs: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)[^;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const spec = m[1] ?? m[2];
    if (spec) specs.push(spec);
  }
  return specs;
}

function resolveLocal(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec).replace(/\.js$/, "");
  for (const candidate of [`${base}.ts`, resolve(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every local module reachable from the entry, plus every bare package specifier. */
function walk(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const spec of importsOf(file)) {
      const local = resolveLocal(file, spec);
      if (local) {
        queue.push(local);
      } else if (!spec.startsWith("node:")) {
        packages.add(spec);
      }
    }
  }
  return { files, packages };
}

describe("agentic-kanban-worker binary isolation", () => {
  const { files, packages } = walk(ENTRY);
  const normalized = [...files].map((f) => f.replace(/\\/g, "/"));

  it("reaches a small, self-contained module graph", () => {
    expect(existsSync(ENTRY)).toBe(true);
    // Sanity: the walk actually traversed (entry + worker modules + cli command).
    expect(files.size).toBeGreaterThan(3);
    expect(files.size).toBeLessThan(25);
  });

  it("never reaches the database or board-service layer", () => {
    const offenders = normalized.filter((f) =>
      FORBIDDEN_LOCAL.some((bad) => f.includes(bad.replace("src/", "/src/")) || f.includes(bad)),
    );
    expect(
      offenders,
      `The worker binary's import graph reached board-only modules:\n${offenders.join("\n")}\n` +
        "That re-introduces the DB/server load this binary exists to avoid — break the import.",
    ).toEqual([]);
  });

  it("depends only on npm packages a worker machine actually needs", () => {
    const bare = [...packages].filter((p) => !p.startsWith("@agentic-kanban/"));
    const leaked = bare.filter((p) => FORBIDDEN_PACKAGES.some((bad) => p === bad || p.startsWith(`${bad}/`)));
    expect(leaked, `Worker binary pulled in board-only packages: ${leaked.join(", ")}`).toEqual([]);
    // Whatever it does use must be a short, deliberate list.
    expect(bare.sort()).toEqual(["commander", "ws"]);
  });

  it("only uses shared subpaths that are dependency-free", () => {
    const sharedSpecs = [...packages].filter((p) => p.startsWith("@agentic-kanban/shared"));
    for (const spec of sharedSpecs) {
      // Deep paths only — the barrel re-exports the whole library surface.
      expect(spec, `worker code must import shared deep paths, not the barrel: ${spec}`)
        .toMatch(/^@agentic-kanban\/shared\/lib\//);
    }
    expect(sharedSpecs.length).toBeGreaterThan(0);
  });
});
