import { describe, expect, it } from "vitest";
import ts from "typescript";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../../../..");
const serverSrc = join(repoRoot, "packages/server/src");
const sharedPackageJson = join(repoRoot, "packages/shared/package.json");

function findTypeScriptFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      return findTypeScriptFiles(fullPath);
    }
    return fullPath.endsWith(".ts") || fullPath.endsWith(".tsx") ? [fullPath] : [];
  });
}

const SHARED_SUBPATH_PREFIX = "@agentic-kanban/shared/";

function collectSharedSubpathImports(filePath: string): string[] {
  const text = readFileSync(filePath, "utf8");
  // Parsing every server file with the TypeScript compiler is the whole cost of this
  // scan (~14s), and most files never mention the shared package. A substring check
  // first skips the AST build for them; any file with a real subpath import must
  // contain this literal, so the filter cannot hide a violation.
  if (!text.includes(SHARED_SUBPATH_PREFIX)) {
    return [];
  }
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true);
  const imports = new Set<string>();

  function recordModuleSpecifier(moduleSpecifier: ts.Expression | undefined) {
    if (!moduleSpecifier || !ts.isStringLiteralLike(moduleSpecifier)) {
      return;
    }
    const specifier = moduleSpecifier.text;
    if (specifier.startsWith(SHARED_SUBPATH_PREFIX)) {
      imports.add(`.${specifier.slice("@agentic-kanban/shared".length)}`);
    }
  }

  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      recordModuleSpecifier(node.moduleSpecifier);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      recordModuleSpecifier(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return [...imports];
}

// This scan walks every server source file and TypeScript-parses the ones that
// reference the shared package. That is inherently heavy (seconds even when idle) and
// its cost scales with the repo, so under a full parallel run it blew the suite's 20s
// default and reported a TIMEOUT rather than its real verdict — a permanently red gate
// that says nothing. Give it explicit slack, per the vitest.config.ts rationale
// ("give heavy tests slack under load"). The env override keeps a tighter CI knob.
const SCAN_TIMEOUT_MS = Number(process.env.VITEST_TEST_TIMEOUT) || 90_000;

describe("shared package exports", () => {
  it("covers every @agentic-kanban/shared subpath imported by the server", () => {
    const sharedPackage = JSON.parse(readFileSync(sharedPackageJson, "utf8")) as {
      exports?: Record<string, unknown>;
    };
    const exportedSubpaths = new Set(Object.keys(sharedPackage.exports ?? {}));
    const missingExports = new Map<string, Set<string>>();

    for (const filePath of findTypeScriptFiles(serverSrc)) {
      for (const subpath of collectSharedSubpathImports(filePath)) {
        if (!exportedSubpaths.has(subpath)) {
          const relativePath = relative(repoRoot, filePath).replaceAll("\\", "/");
          const files = missingExports.get(subpath) ?? new Set<string>();
          files.add(relativePath);
          missingExports.set(subpath, files);
        }
      }
    }

    expect(
      [...missingExports.entries()].map(
        ([subpath, files]) => `${subpath} imported by ${[...files].join(", ")}`
      )
    ).toEqual([]);
  }, SCAN_TIMEOUT_MS);

  it("every export subpath has a 'development' condition pointing to src/ (stale-dist regression)", () => {
    // Regression guard for AK-567: every subpath in shared/package.json exports must
    // have a "development" condition so that `tsx --conditions development` resolves
    // to live TypeScript source rather than stale dist/ after merging a shared change.
    const sharedPackage = JSON.parse(readFileSync(sharedPackageJson, "utf8")) as {
      exports?: Record<string, Record<string, string>>;
    };
    const exports = sharedPackage.exports ?? {};
    const missing: string[] = [];

    for (const [subpath, conditions] of Object.entries(exports)) {
      if (typeof conditions !== "object" || conditions === null) {
        missing.push(`${subpath}: not an object`);
        continue;
      }
      const devEntry = (conditions as Record<string, string>)["development"];
      if (!devEntry) {
        missing.push(`${subpath}: missing "development" condition`);
      } else if (!devEntry.startsWith("./src/")) {
        missing.push(`${subpath}: "development" condition "${devEntry}" does not point to ./src/`);
      }
    }

    expect(missing).toEqual([]);
  });
});
