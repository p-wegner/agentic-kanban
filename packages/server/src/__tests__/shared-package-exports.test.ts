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

function collectSharedSubpathImports(filePath: string): string[] {
  const source = ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const imports = new Set<string>();

  function recordModuleSpecifier(moduleSpecifier: ts.Expression | undefined) {
    if (!moduleSpecifier || !ts.isStringLiteralLike(moduleSpecifier)) {
      return;
    }
    const specifier = moduleSpecifier.text;
    if (specifier.startsWith("@agentic-kanban/shared/")) {
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
  });
});
