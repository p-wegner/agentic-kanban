// @covers mcp-server.govern.catalog-parity [config,api]
//
// Fast, NON-SPAWNING twin of the parity assertion in mcp-tools.test.ts (#982).
//
// The spawn-based mcp-tools.test.ts is excluded from `pnpm test:mine` (slow stdio
// integration), so its catalog↔runtime parity gate sat red for 7 days while merges
// landed. This test asserts the SAME contract without spawning the server:
//
//   1. It statically parses the TOOL_REGISTRARS map out of src/index.ts (the map is
//      defined in the server entrypoint, which has import-time side effects — top-level
//      main(), stdio transport — so it cannot be imported here).
//   2. It dynamically imports each tool module and invokes its registrar against a
//      capturing stub McpServer, yielding the exact runtime (name, description) pairs
//      the real server would register.
//   3. It diffs those against MCP_TOOL_DEFINITIONS (packages/shared/src/lib/
//      mcp-tool-definitions.ts — the catalog that drives the Settings tool browser):
//        - advertised ⊆ registered  → no catalog entry references a non-existent tool
//          (the mark_ready_for_merge failure class).
//        - registered ⊆ advertised  → no runtime tool ships without a catalog entry.
//        - description EQUALITY (#977) — the runtime server.tool(...) text is the
//          single source of truth; copy it verbatim into MCP_TOOL_DEFINITIONS.
//
// The spawn-based test remains in the full `pnpm test` suite (it additionally covers
// the live stdio surface + disabled-tools interplay); this one is the merge-blocking
// fast gate.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MCP_TOOL_DEFINITIONS } from "@agentic-kanban/shared/lib";

const SRC_DIR = resolve(import.meta.dirname, "..");

// Point the module-level db singleton (loaded transitively by every tool module) at a
// throwaway temp DB BEFORE any tool module is imported (all tool imports below are
// dynamic, so this assignment reliably precedes them). db.ts only runs PRAGMAs at
// import time — no schema is needed, and the real dev kanban.db is never touched.
const tmpDir = mkdtempSync(join(tmpdir(), "mcp-parity-"));
process.env.DB_URL = `file:${join(tmpDir, "parity-throwaway.db")}`;

// vitest's vite transform provides import.meta.glob; this package has no vite/client
// types on its tsconfig path, so declare the minimal shape locally. The call itself must
// stay a bare, statically-analyzable `import.meta.glob(...)` for the transform to fire.
declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<Record<string, unknown>>>;
  }
}

// Lazy importers for every tool module, resolved by vite/vitest (handles the .js → .ts
// specifier mapping that a raw dynamic import of index.ts's "./tools/*.js" paths cannot).
const toolModules = import.meta.glob("../tools/*.ts");

interface ParsedRegistry {
  /** TOOL_REGISTRARS key (the wired tool name) → registrar identifier. */
  entries: Map<string, string>;
  /** registrar identifier → "./tools/<file>.js" import specifier. */
  importOf: Map<string, string>;
}

function parseIndexRegistry(): ParsedRegistry {
  const source = readFileSync(join(SRC_DIR, "index.ts"), "utf-8");

  const importOf = new Map<string, string>();
  const importRe = /import\s*\{([^}]+)\}\s*from\s*["'](\.\/tools\/[^"']+)["']/g;
  for (const m of source.matchAll(importRe)) {
    for (const rawIdent of m[1].split(",")) {
      const ident = rawIdent.trim();
      if (ident) importOf.set(ident, m[2]);
    }
  }

  // Non-greedy up to the first `= {` — the map's type annotation itself contains `=>`
  // (arrow type), so a naive [^=]* would stop inside the annotation and never match.
  const block = source.match(/const TOOL_REGISTRARS[\s\S]*?=\s*\{([\s\S]*?)\n\};/);
  if (!block) throw new Error("Could not find the TOOL_REGISTRARS map in src/index.ts");

  const entries = new Map<string, string>();
  const entryRe = /^\s*([a-zA-Z0-9_]+):\s*(register\w+)\s*,?\s*$/gm;
  for (const m of block[1].matchAll(entryRe)) {
    if (entries.has(m[1])) throw new Error(`Duplicate TOOL_REGISTRARS key: ${m[1]}`);
    entries.set(m[1], m[2]);
  }
  return { entries, importOf };
}

describe("MCP catalog ↔ runtime parity (fast, no server spawn)", () => {
  /** Runtime registrations captured from invoking every registrar: name → description. */
  const runtime = new Map<string, string>();
  let registry: ParsedRegistry;

  // Importing all ~80 tool modules (first-run transform included) can exceed the
  // default 10s hook timeout on a cold cache — still no spawn, just module loading.
  beforeAll(async () => {
    registry = parseIndexRegistry();

    const server = {
      tool: (name: string, description: unknown, ..._rest: unknown[]) => {
        if (typeof description !== "string") {
          throw new Error(
            `Tool '${name}' registered without a string description as the second ` +
              `server.tool(...) argument — the parity gate requires the described overload.`,
          );
        }
        if (runtime.has(name)) throw new Error(`Duplicate runtime tool registration: ${name}`);
        runtime.set(name, description);
      },
    } as unknown as McpServer;

    for (const [toolName, registrarName] of registry.entries) {
      const spec = registry.importOf.get(registrarName);
      if (!spec) {
        throw new Error(
          `TOOL_REGISTRARS maps '${toolName}' to ${registrarName}, but index.ts has no ` +
            `matching import from ./tools/ — parse drift or a broken wiring.`,
        );
      }
      const globKey = `../tools/${basename(spec).replace(/\.js$/, ".ts")}`;
      const loader = toolModules[globKey];
      if (!loader) throw new Error(`No tool module found for ${spec} (glob key ${globKey})`);
      const mod = await loader();
      const registrar = mod[registrarName];
      if (typeof registrar !== "function") {
        throw new Error(`${globKey} does not export a function named ${registrarName}`);
      }
      (registrar as (s: McpServer) => void)(server);
    }

    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort: the libsql client may still hold the throwaway file on Windows
    }
  }, 60_000);

  it("the parsed TOOL_REGISTRARS map is substantial and every registrar registers its wired name", () => {
    // Parse sanity: if the index.ts regex ever stops matching, fail loudly instead of
    // green-lighting an empty comparison.
    expect(registry.entries.size).toBeGreaterThan(80);

    // Each map key must be an actual runtime registration — catches a registrar whose
    // server.tool(...) name drifted from its TOOL_REGISTRARS key (the disabled_mcp_tools
    // gate matches on the KEY, so a drifted name would make that tool undisableable).
    const notRegistered = [...registry.entries.keys()].filter((name) => !runtime.has(name));
    expect(
      notRegistered,
      `TOOL_REGISTRARS keys whose registrar did not register a tool of that name: ${notRegistered.join(", ")}`,
    ).toEqual([]);
  });

  it("catalog and runtime stay in exact name-parity in both directions", () => {
    const advertised = new Set(MCP_TOOL_DEFINITIONS.map((d) => d.name));

    const missing = [...advertised].filter((name) => !runtime.has(name));
    expect(missing, `advertised in catalog but not registered at runtime: ${missing.join(", ")}`).toEqual([]);

    const uncatalogued = [...runtime.keys()].filter((name) => !advertised.has(name));
    expect(
      uncatalogued,
      `registered at runtime but missing from MCP_TOOL_DEFINITIONS (add it + a category so ` +
        `the Settings tool browser shows it): ${uncatalogued.join(", ")}`,
    ).toEqual([]);

    expect(runtime.has("mark_ready_for_merge")).toBe(true);
  });

  it("catalog descriptions match the runtime registrations verbatim (#977) and none are blank", () => {
    const blank = [...runtime].filter(([, desc]) => desc.trim().length === 0).map(([name]) => name);
    expect(blank, `tools registered with an empty description: ${blank.join(", ")}`).toEqual([]);

    const catalog = new Map(MCP_TOOL_DEFINITIONS.map((d) => [d.name, d.description]));
    const drift = [...runtime]
      .filter(([name, desc]) => catalog.has(name) && catalog.get(name) !== desc)
      .map(
        ([name, desc]) =>
          `${name}:\n  runtime: ${JSON.stringify(desc)}\n  catalog: ${JSON.stringify(catalog.get(name))}`,
      );
    expect(
      drift,
      `catalog descriptions drifted from the runtime registration (runtime is the source of ` +
        `truth — copy the server.tool(...) description into MCP_TOOL_DEFINITIONS):\n${drift.join("\n")}`,
    ).toEqual([]);
  });
});
