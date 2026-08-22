// @gate:always-run — walks the client, server, mcp-server, e2e, desktop and shared trees plus scripts/; imports nothing it checks.
/**
 * `shared/lib` is for code MORE THAN ONE package needs (#590). This is the first thing
 * that checks it (#730).
 *
 * #590 states the rule in prose and nothing enforced it, so the drift went the way
 * unenforced rules go: measured on the tree at #730, **31 of 108** modules directly under
 * `packages/shared/src/lib/` have exactly one consuming package — 28 of them `server`
 * alone — and are not used by `shared`'s own code either. Each one costs a second package
 * on every commit that touches it, buys nothing, and makes `shared`'s containment figure
 * look like a boundary defect when it is mostly just the DB schema and the wire contract
 * doing their job.
 *
 * ## Why this is a ratchet and NOT a batch of 31 moves
 *
 * #730 asked whether the horizontal `client`/`server`/`shared`/`mcp-server` split is why
 * one unit of work costs three packages, and proposed splitting `shared` by consumer.
 * `scripts/measure-package-coupling.mjs` answers that, and the answer is no:
 *
 *   - 26.2% of production commits touch 2+ packages (the ticket's 29% reproduces), but
 *     **49.7% of those crossings contain no `shared` file at all** — they are
 *     `client <-> server`, i.e. two processes talking over HTTP. No rearrangement of
 *     packages collapses that; the missing part is contract ENFORCEMENT, which is #780.
 *   - ~21% are `schema`/`types`: the Drizzle tables and the hand-authored wire DTOs.
 *     Those are deliberately one declaration with several consumers
 *     (`packages/shared/CLAUDE.md`, "Domain model boundary"), so their crossing is the
 *     design working, not failing.
 *   - Only ~26% involve `shared/lib` at all, and relocating EVERY single-consumer module
 *     in it would collapse **36 of 1587** multi-package commits — 2.3%, i.e. 27.4% would
 *     become 26.8%. A 31-file move for that is churn, and churn in the package every
 *     other package imports.
 *
 * So the population is real but the retroactive move is not worth its risk. What IS worth
 * having is the thing that was missing: something that stops the population GROWING. The
 * set below is grandfathered and may only SHRINK — a new single-consumer module in
 * `shared/lib` fails this suite, which is the case #590 was written to prevent and the
 * only case where the fix is free (the module is new; put it in its consumer).
 *
 * ## What counts as a consumer, and why the resolution has to be per-symbol
 *
 * Consumers do not import these modules by path. `packages/client` and `packages/server`
 * import through the `@agentic-kanban/shared/lib` barrel, so a path-based scan reports
 * almost nothing (measured: it found no external importer for 18 modules that plainly
 * have one). This suite therefore resolves both forms:
 *
 *   - a deep import — `@agentic-kanban/shared/lib/<name>` — attributed to `<name>`;
 *   - a barrel import — `@agentic-kanban/shared` or `@agentic-kanban/shared/lib` —
 *     attributed to whichever lib module EXPORTS each imported binding.
 *
 * Two modules exporting the same name attribute to both, which over-counts consumers. That
 * is the safe direction for a ratchet: it can hide a violation, never invent one.
 *
 * ## Three exemptions, all of them "one package is the wrong question"
 *
 *   1. **Used by `shared`'s own code.** A module another `shared` module imports has to
 *      live in `shared` whatever its external consumer count is (`exec-result.ts` under
 *      `git-exec.ts`, `plugin-placeholders.ts` under `plugin-manifest.ts`). 40 modules.
 *   2. **Type-only consumption is still consumption.** A `import type` edge is erased at
 *      runtime but is exactly the wire-contract case, so it counts.
 *   3. **`scripts/` counts as a consumer package.** Root build/gate tooling needing a
 *      module is a second audience, which is what the rule is about.
 *
 * Test files count toward a package's consumption only if that package also consumes it in
 * production — a module whose sole user is a test suite in one package is still
 * single-consumer, and several of the entries below are exactly that.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { parseGuardSource, walkPackageSources, packagesRootFrom } from "./helpers/guard-scan.js";

const PACKAGES_ROOT = packagesRootFrom(path.dirname(new URL(import.meta.url).pathname.slice(1)), 2);
const LIB_DIR = path.join(PACKAGES_ROOT, "shared", "src", "lib");
const SHARED_SRC = path.join(PACKAGES_ROOT, "shared", "src");
const REPO_ROOT = path.resolve(PACKAGES_ROOT, "..");

/** Packages that may consume `shared/lib`. `scripts` is the repo-root tooling bucket. */
const CONSUMER_ROOTS: ReadonlyArray<readonly [name: string, absDir: string]> = [
  ["client", path.join(PACKAGES_ROOT, "client")],
  ["server", path.join(PACKAGES_ROOT, "server")],
  ["mcp-server", path.join(PACKAGES_ROOT, "mcp-server")],
  ["e2e", path.join(PACKAGES_ROOT, "e2e")],
  ["desktop", path.join(PACKAGES_ROOT, "desktop")],
  ["scripts", path.join(REPO_ROOT, "scripts")],
];

/**
 * Grandfathered single-consumer modules under `shared/lib`, each mapped to the ONE package
 * that consumes it (`"-"` = no consumer found anywhere outside `shared`). Frozen at #730.
 *
 * This list may only SHRINK. To remove an entry, move the module into the package named
 * beside it (`packages/<pkg>/src/lib/`), drop its `lib/index.ts` re-export, and delete the
 * line. To ADD one you have to justify why a module only one package needs belongs in the
 * package every package imports — the answer is normally that it does not.
 */
const GRANDFATHERED: Readonly<Record<string, string>> = {
  "backlog-markdown.ts": "server",
  "builder-skill-policy.ts": "server",
  "bundled-skills.ts": "mcp-server",
  "butler-ticket-prompt.ts": "client",
  "changed-packages.ts": "server",
  "container-dep-volumes.ts": "server",
  "coupling-overlap.ts": "server",
  "dependency-type-traits.ts": "server",
  "devcontainer-exec.ts": "server",
  "docker-exec.ts": "server",
  "docs-only-diff.ts": "server",
  "file-contention.ts": "server",
  "fk-actions-repair.ts": "server",
  "gradle-env.ts": "server",
  "mcp-tool-definitions.ts": "client",
  "merge-policy.ts": "server",
  "migration-source.ts": "server",
  "profile-selection.ts": "server",
  "repo-install-state.ts": "server",
  "repo-lock.ts": "server",
  "sanitize-utf8.ts": "server",
  "service-compose-lint.ts": "server",
  "service-ports.ts": "server",
  "service-stack-codec.ts": "server",
  "smoke-check.ts": "server",
  "temp-dir.ts": "server",
  "ticket-context.ts": "server",
  "ticket-group.ts": "server",
  "transcript-cwd-encoding.ts": "server",
  "ttl-memo.ts": "server",
  "worker-protocol.ts": "server",
};

/** Top-level modules under `shared/src/lib` (the barrel layer; nested dirs are internals). */
function libModules(): string[] {
  return fs
    .readdirSync(LIB_DIR)
    .filter((n) => n.endsWith(".ts") && !n.includes(".test.") && !n.endsWith(".d.ts") && n !== "index.ts")
    .sort();
}

/** Every name a module exports — values and types alike; a type-only consumer still counts. */
function exportedNames(absFile: string): Set<string> {
  const sf = parseGuardSource(absFile);
  const names = new Set<string>();
  for (const stmt of sf.statements) {
    const modifiers = ts.canHaveModifiers(stmt) ? (ts.getModifiers(stmt) ?? []) : [];
    const isExported = modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (isExported) {
      if (ts.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations) if (ts.isIdentifier(d.name)) names.add(d.name.text);
      } else if (
        (ts.isFunctionDeclaration(stmt) ||
          ts.isClassDeclaration(stmt) ||
          ts.isInterfaceDeclaration(stmt) ||
          ts.isTypeAliasDeclaration(stmt) ||
          ts.isEnumDeclaration(stmt)) &&
        stmt.name
      ) {
        names.add(stmt.name.text);
      }
    }
    if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) names.add(el.name.text);
    }
  }
  return names;
}

interface ImportRecord {
  spec: string;
  /** Bindings taken from the module; `"*"` for a namespace or `export *`. */
  bindings: string[];
}

function importsOf(absFile: string): ImportRecord[] {
  const sf = parseGuardSource(absFile);
  const out: ImportRecord[] = [];
  for (const stmt of sf.statements) {
    let spec: string | null = null;
    const bindings: string[] = [];
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      spec = stmt.moduleSpecifier.text;
      const clause = stmt.importClause;
      if (clause?.name) bindings.push(clause.name.text);
      if (clause?.namedBindings) {
        if (ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) bindings.push((el.propertyName ?? el.name).text);
        } else bindings.push("*");
      }
    } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
      spec = stmt.moduleSpecifier.text;
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) bindings.push((el.propertyName ?? el.name).text);
      } else bindings.push("*");
    }
    if (spec) out.push({ spec, bindings });
  }
  return out;
}

const DEEP_IMPORT = /^@agentic-kanban\/shared\/lib\/([\w./-]+?)(?:\.js)?$/;
const BARREL_SPECS = new Set(["@agentic-kanban/shared", "@agentic-kanban/shared/lib"]);
const isTestPath = (f: string): boolean => /(__tests__|[.\\/](test|spec)[.\\/]|\.test\.|\.spec\.)/.test(f);

interface Survey {
  /** module file name -> consuming package names (production consumption only) */
  production: Map<string, Set<string>>;
  /** module file name -> consuming package names counting test files too */
  withTests: Map<string, Set<string>>;
  /** modules imported by shared's OWN code (barrel re-export excluded) */
  usedInsideShared: Set<string>;
}

function survey(): Survey {
  const modules = libModules();
  const owners = new Map<string, string[]>(); // exported name -> module file names
  for (const mod of modules) {
    for (const name of exportedNames(path.join(LIB_DIR, mod))) {
      const list = owners.get(name);
      if (list) list.push(mod);
      else owners.set(name, [mod]);
    }
  }

  const production = new Map<string, Set<string>>(modules.map((m) => [m, new Set<string>()]));
  const withTests = new Map<string, Set<string>>(modules.map((m) => [m, new Set<string>()]));
  const add = (mod: string, pkg: string, isTest: boolean): void => {
    if (!withTests.has(mod)) return;
    withTests.get(mod)!.add(pkg);
    if (!isTest) production.get(mod)!.add(pkg);
  };

  for (const [pkg, dir] of CONSUMER_ROOTS) {
    const files = walkPackageSources(dir, {
      extensions: [".ts", ".tsx", ".mts", ".mjs"],
      includeTests: true,
      skipDirs: new Set(["node_modules", "dist", "coverage", ".git"]),
    });
    for (const file of files) {
      const isTest = isTestPath(file);
      for (const { spec, bindings } of importsOf(file)) {
        const deep = DEEP_IMPORT.exec(spec);
        if (deep) {
          add(`${deep[1]}.ts`, pkg, isTest);
          continue;
        }
        if (!BARREL_SPECS.has(spec)) continue;
        for (const binding of bindings) {
          for (const mod of owners.get(binding) ?? []) add(mod, pkg, isTest);
        }
      }
    }
  }

  // Modules that shared's own code imports. The lib barrel re-exports everything, so it is
  // not evidence of internal use and is excluded.
  const usedInsideShared = new Set<string>();
  const moduleSet = new Set(modules);
  for (const file of walkPackageSources(SHARED_SRC)) {
    if (path.resolve(file) === path.resolve(LIB_DIR, "index.ts")) continue;
    for (const { spec } of importsOf(file)) {
      if (!spec.startsWith(".")) continue;
      const leaf = /(?:^|\/)([\w.-]+)\.js$/.exec(spec)?.[1];
      if (!leaf) continue;
      const candidate = `${leaf}.ts`;
      if (!moduleSet.has(candidate)) continue;
      if (path.resolve(file) === path.resolve(LIB_DIR, candidate)) continue;
      // Only a relative specifier that actually resolves into lib/ counts.
      if (!fs.existsSync(path.resolve(path.dirname(file), spec.replace(/\.js$/, ".ts")))) continue;
      usedInsideShared.add(candidate);
    }
  }

  return { production, withTests, usedInsideShared };
}

/** Modules under `shared/lib` that only one package needs (or none), ignoring internal use. */
function singleConsumerModules(s: Survey): Map<string, string> {
  const out = new Map<string, string>();
  for (const [mod, pkgs] of s.production) {
    if (s.usedInsideShared.has(mod)) continue;
    if (pkgs.size > 1) continue;
    if (pkgs.size === 1) {
      out.set(mod, [...pkgs][0]);
      continue;
    }
    // No production consumer: fall back to the test-only audience, so the message names
    // somewhere to move it rather than just "nobody".
    const testPkgs = s.withTests.get(mod) ?? new Set<string>();
    out.set(mod, testPkgs.size === 1 ? [...testPkgs][0] : "-");
  }
  return out;
}

describe("shared/lib holds code more than one package needs (#590 ratchet, #730)", () => {
  const s = survey();
  const found = singleConsumerModules(s);

  it("resolves real consumers, so the scan cannot pass vacuously", () => {
    // error-message.ts is imported by all three of client, server and mcp-server; if the
    // barrel-symbol resolution breaks, this is what notices.
    expect([...(s.production.get("error-message.ts") ?? [])].sort()).toEqual(
      ["client", "mcp-server", "server"],
    );
    // And the internal-use exemption must actually find something.
    expect(s.usedInsideShared.size).toBeGreaterThan(10);
  });

  it("no NEW single-consumer module appears in shared/lib", () => {
    const added = [...found]
      .filter(([mod]) => !(mod in GRANDFATHERED))
      .map(([mod, pkg]) => `  shared/src/lib/${mod} — only ${pkg === "-" ? "no package" : `packages/${pkg}`} uses it`);
    expect(
      added,
      `These modules live in shared/lib but only one package needs them, which is what #590 says\n` +
        `shared/lib is not for. Each one adds a package to every commit that touches it.\n` +
        `Move it to packages/<pkg>/src/lib/ and drop its lib/index.ts re-export — while it is new\n` +
        `that is a cheap edit, which is the whole reason this guard fails NOW rather than later.\n` +
        `If it genuinely belongs in shared (another shared module is about to import it, or a\n` +
        `second consumer lands in the same change), say so in GRANDFATHERED with the reason.\n` +
        added.join("\n"),
    ).toEqual([]);
  });

  it("the grandfathered list is not stale — an entry that got fixed must be deleted", () => {
    const stale: string[] = [];
    for (const [mod, pkg] of Object.entries(GRANDFATHERED)) {
      if (!fs.existsSync(path.join(LIB_DIR, mod))) {
        stale.push(`  ${mod} — no longer exists under shared/src/lib (moved or deleted): drop the entry`);
        continue;
      }
      const nowPkgs = s.production.get(mod) ?? new Set<string>();
      if (nowPkgs.size > 1) {
        stale.push(`  ${mod} — now consumed by ${[...nowPkgs].sort().join(", ")}: it belongs in shared, drop the entry`);
        continue;
      }
      const actual = found.get(mod);
      if (actual && actual !== pkg) {
        stale.push(`  ${mod} — consumer is now "${actual}", not "${pkg}": update the entry`);
      }
    }
    expect(
      stale,
      `A baseline nobody lowers stops being a ceiling and becomes a budget. Fix these lines:\n` +
        stale.join("\n"),
    ).toEqual([]);
  });
});
