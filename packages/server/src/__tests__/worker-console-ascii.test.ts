// #1366: the standalone worker binary prints to a Windows PowerShell 5.1 console (OEM codepage), where
// an em dash renders as mojibake. Every STRING the worker modules contain must be ASCII; comments
// are not output and are exempt.
import { describe, expect, it } from "vitest";
import ts from "typescript";

// import.meta.glob keeps the scanned modules in this suite's import graph, so a change to any of
// them selects this guard without an always-run marker or a private directory walker.
const WORKER_SOURCES = import.meta.glob(["../worker/*.ts", "../cli/commands/worker-*.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

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
