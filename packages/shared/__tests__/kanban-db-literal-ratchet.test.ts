// @gate:always-run — scans every package's src/ tree for raw kanban.db path literals; imports nothing it checks (#854).
import { describe, it, expect } from "vitest";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { walkPackageSources, packagesRootFrom, compareRatchet, parseGuardSource, forEachNode } from "./helpers/guard-scan.js";

/**
 * Guard (#854): the ONLY sanctioned way to locate `kanban.db` is the shared resolver
 * (`resolveDbLocation` in `packages/shared/src/lib/db-path.ts`), which carries the
 * size floor (#165), the content probe (#663), the placeholder-env rejection (#803),
 * the test-throwaway redirect (#231) and — since #854 — the stub self-heal. A raw
 * `kanban.db` path literal anywhere else is a caller that bypasses ALL of that: a
 * bare `existsSync(<checkout>/kanban.db)` probe or a hardcoded `file:kanban.db` open
 * adopts (and, for a `file:` open, CREATES) a stub the resolver would have rejected.
 * That is exactly how the shadow-DB incidents happened — drizzle-kit's old hardcoded
 * `file:kanban.db` minted a schema-only shadow in the checkout, and
 * `seed-example-session.ts`'s hardcoded `file:<checkout>/kanban.db` could mint a
 * 0-byte one.
 *
 * What counts as a PATH literal: a string/template-literal fragment that contains
 * `kanban.db` and no whitespace. Prose mentioning the filename (log messages, prompt
 * text — e.g. "do not write to kanban.db yourself") contains spaces and is not a
 * path; comments are not AST nodes at all, so documentation stays free.
 *
 * SANCTIONED modules construct candidate paths FOR the resolver or implement it.
 * BASELINE modules are today's offenders, grandfathered SHRINK-ONLY (compareRatchet
 * reports both regressions and stale entries): route them through the resolver —
 * `getDbUrl()` / `DB_LOCATION` from `packages/server/src/db/data-dir.ts` — and lower
 * or delete their entry.
 */

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGES_ROOT = packagesRootFrom(TEST_DIR, 2);

/** Files allowed to spell a kanban.db path: they define the resolver or feed it its candidates. */
const SANCTIONED = new Map<string, string>([
  ["shared/src/lib/db-path.ts", "The resolver itself — single source of truth for kanban.db location (#962/#165/#663/#854)."],
  ["server/src/db/data-dir.ts", "Declares the server's in-checkout candidate paths and passes them TO the resolver."],
  ["mcp-server/src/db.ts", "Declares the MCP server's in-checkout candidate path and passes it TO the resolver."],
]);

/**
 * Today's offenders, frozen shrink-only. Each spells a kanban.db path beside the
 * resolver instead of through it.
 */
const BASELINE: Record<string, number> = {
  // resolve(DATA_DIR, "kanban.db") — DATA_DIR does come from the resolver, but the
  // filename join re-derives what DB_LOCATION.path already is.
  "server/src/db/backup.ts": 1,
  // Maintenance scripts that target the in-checkout dev DB by construction. They are
  // deliberate about WHICH file they touch, but each re-derives the path privately.
  "server/src/scripts/db-repair.ts": 1,
  "server/src/scripts/db-reset.ts": 3,
  "server/src/scripts/db-restore.ts": 1,
};

const EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs"];

/** A literal fragment is PATH-LIKE when it names the file and holds no prose whitespace. */
function isPathLikeDbLiteral(text: string): boolean {
  return text.includes("kanban.db") && !/\s/.test(text);
}

/** Count raw kanban.db path literals in one source file (string + template-literal fragments). */
function countDbPathLiterals(absFile: string): number {
  const sf = parseGuardSource(absFile, readFileSync(absFile, "utf8"));
  let count = 0;
  forEachNode(sf, (node) => {
    // Covers plain string literals, `...` no-substitution templates, and every literal
    // fragment (head/middle/tail) of an interpolated template — `${dir}/kanban.db` included.
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddleOrTemplateTail(node)
    ) {
      if (isPathLikeDbLiteral(node.text)) count += 1;
    }
  });
  return count;
}

function collectSrcFiles(): string[] {
  const files: string[] = [];
  for (const pkg of readdirSync(PACKAGES_ROOT)) {
    if (pkg.startsWith(".")) continue;
    const srcDir = join(PACKAGES_ROOT, pkg, "src");
    files.push(...walkPackageSources(srcDir, { extensions: EXTENSIONS }));
  }
  return files;
}

function relKey(absFile: string): string {
  return relative(PACKAGES_ROOT, absFile).split(sep).join("/");
}

describe("kanban.db path-literal ratchet (#854)", () => {
  it("the scan is not vacuous — it reaches the resolver and a real package tree", () => {
    const files = collectSrcFiles();
    expect(files.length, "scan reached almost no files — the gate is disarmed").toBeGreaterThan(100);
    expect(
      files.some((f) => relKey(f) === "shared/src/lib/db-path.ts"),
      "scan did not reach the resolver itself — the gate is disarmed",
    ).toBe(true);
  });

  it("every SANCTIONED entry is live — the file exists and really spells the path", () => {
    for (const rel of SANCTIONED.keys()) {
      const abs = join(PACKAGES_ROOT, ...rel.split("/"));
      expect(existsSync(abs), `sanctioned file is gone (de-list it): ${rel}`).toBe(true);
      expect(
        countDbPathLiterals(abs),
        `sanctioned file no longer spells a kanban.db path (de-list it): ${rel}`,
      ).toBeGreaterThan(0);
    }
  });

  it("no NEW raw kanban.db path literal outside the sanctioned resolver modules; baseline only shrinks", () => {
    const current: Record<string, number> = {};
    for (const file of collectSrcFiles()) {
      const rel = relKey(file);
      if (SANCTIONED.has(rel)) continue;
      const count = countDbPathLiterals(file);
      if (count > 0) current[rel] = count;
    }

    const verdict = compareRatchet(BASELINE, current);
    expect(
      verdict.over,
      `Raw kanban.db path literal(s) outside the sanctioned resolver modules. Locate the DB via ` +
        `resolveDbLocation (@agentic-kanban/shared/lib/db-path) or getDbUrl()/DB_LOCATION ` +
        `(packages/server/src/db/data-dir.ts) instead — a hardcoded path bypasses the size floor, ` +
        `content probe and stub self-heal, and a file: open CREATES the stub it then adopts (#854):\n` +
        verdict.over.join("\n"),
    ).toEqual([]);
    expect(
      verdict.stale,
      `Stale baseline entries — an offender shrank or vanished; lower/remove its entry so the ` +
        `headroom cannot hide a new literal:\n` + verdict.stale.join("\n"),
    ).toEqual([]);
  });
});
