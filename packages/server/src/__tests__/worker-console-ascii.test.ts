// @gate:always-run always - reads worker/*.ts and cli/commands/worker-*.ts as text, outside its import graph.
// #1366: the standalone worker binary prints to a Windows PowerShell 5.1 console (OEM codepage), where
// an em dash renders as mojibake. Every STRING the worker modules contain must be ASCII; comments
// are not output and are exempt.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { walkPackageSources } from "../../../shared/__tests__/helpers/guard-scan.js";

const SRC = path.resolve(import.meta.dirname, "..");
const isWorkerSource = (abs: string): boolean => {
  const rel = path.relative(SRC, abs).split(path.sep).join("/");
  return /^worker\/[^/]+\.ts$/.test(rel) || /^cli\/commands\/worker-[^/]+\.ts$/.test(rel);
};
const WORKER_SOURCES: Record<string, string> = Object.fromEntries(
  walkPackageSources(SRC)
    .filter(isWorkerSource)
    .map((abs) => [path.relative(SRC, abs).split(path.sep).join("/"), readFileSync(abs, "utf-8")]),
);

const workerModules = (): string[] => Object.keys(WORKER_SOURCES);
/** Non-ASCII characters inside string/template literals (comments are not nodes, so never visited). */
export function nonAsciiInLiterals(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isRegularExpressionLiteral(node)
    ) {
      const m = /[^\x00-\x7F]/.exec(node.getText(sf));
      if (m) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        hits.push(`${file}:${line + 1} U+${m[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe("worker binary console strings are ASCII-only (#1366)", () => {
  it("scans a meaningful set of modules", () => {
    expect(workerModules().length).toBeGreaterThan(20);
  });

  it("the scanner flags a literal but not a comment", () => {
    expect(nonAsciiInLiterals("x.ts", "// a — b\nconst a = 1;")).toEqual([]);
    expect(nonAsciiInLiterals("x.ts", "const a = `x — ${1}`;")).toHaveLength(1);
    expect(nonAsciiInLiterals("x.ts", "const a = 'x…';")).toHaveLength(1);
  });

  it("no worker/*.ts or cli/commands/worker-*.ts string literal contains a non-ASCII character", () => {
    const hits = Object.entries(WORKER_SOURCES).flatMap(([f, text]) => nonAsciiInLiterals(f, text));
    expect(hits).toEqual([]);
  });
});
