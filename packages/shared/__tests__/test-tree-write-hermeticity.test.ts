// @gate:always-run — recursively walks every package's test tree; imports nothing it checks (#680).
import { describe, expect, it } from "vitest";
import path, { join } from "node:path";
import fs, { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import ts from "typescript";
import {
  calleeName,
  forEachNode,
  leadingCommentText,
  lineOf,
  packagesRootFrom,
  parseGuardSource,
  unwrapExpression,
  walkPackageSources,
} from "./helpers/guard-scan.js";

/**
 * No test may WRITE into the real repository tree (#680).
 *
 * #680 is the ticket for a gate that goes red under load and green in isolation, and the
 * mechanism named in it is not a timeout: a repo-scanning guard suite sees a DIFFERENT TREE
 * under parallelism because another suite is mutating the tree while it scans. An untracked
 * `packages/shared/__tests__/zz-adversarial-tmp.test.ts` was observed transiently present
 * during exactly such a run.
 *
 * The concrete instance was #814: `openapi-drift.test.ts`'s negative control rewrote the
 * committed `packages/server/openapi.yaml` to prove the drift gate bites, and restored it in
 * a `finally`. The checkout was found afterwards holding `version: 0.0.0-drifted`. That is
 * worse than untidy — the board's auto-merge withholds every approved workspace while the
 * main checkout has any dirty tracked file, so one leaked byte silently stops the whole
 * board, and the cause is invisible.
 *
 * A `finally` cannot be the guarantee. It is a promise about control flow, and the failure
 * mode here is precisely the one that skips it: a killed vitest worker, a crashed pool, a
 * suite-level timeout under load. The guarantee has to be that the real path is never opened
 * for writing at all — which is a static property, hence this suite.
 *
 * **The rule**: an `fs` write-family call in a test whose destination is anchored to the repo
 * (`import.meta.dirname`, `__dirname`, `fileURLToPath(import.meta.url)`, `process.cwd()`, or a
 * const derived from one) fails, unless the same expression is also anchored to a temp
 * directory. Writing into `mkdtempSync(join(tmpdir(), ...))` is the sanctioned shape and there
 * is abundant prior art for it in this repo.
 *
 * **Deliberately zero-tolerance rather than a shrink-only ratchet.** The measured count at
 * the time of writing is 0 across all packages, and a baseline of zero IS the ratchet: there
 * is nothing to grandfather, so any allowance would only be a place for the first regression
 * to land. A genuinely-needed exception takes an explicit `REPO-TREE-WRITE OK: <reason>`
 * comment on the line above the call, which puts the reason in the diff where a reviewer
 * sees it.
 */

const PACKAGES_ROOT = packagesRootFrom(import.meta.dirname!, 2);
const REPO_ROOT = path.resolve(PACKAGES_ROOT, "..");

/** `fs` calls that create, truncate, move or delete a path. Reads are irrelevant here. */
const WRITE_CALLS = new Set([
  "writeFileSync", "writeFile",
  "appendFileSync", "appendFile",
  "mkdirSync", "mkdir",
  "rmSync", "rm", "rmdirSync", "rmdir",
  "unlinkSync", "unlink",
  "renameSync", "rename",
  "copyFileSync", "copyFile",
  "cpSync", "cp",
  "createWriteStream",
  "outputFileSync", "outputFile",
]);

/** Expressions that resolve to a location INSIDE this checkout. */
const REPO_ANCHOR =
  /\bimport\.meta\.dirname\b|\b__dirname\b|fileURLToPath\s*\(\s*import\.meta\.url\s*\)|\bprocess\.cwd\s*\(\s*\)/;
/** Expressions that resolve to a location OUTSIDE it — the sanctioned destination. */
const TMP_ANCHOR =
  /\btmpdir\s*\(|\bmkdtemp(Sync)?\s*\(|\bos\.tmpdir\b|\bTMPDIR\b|\btmpDir\b|\btempDir\b|process\.env\.(TEMP|TMP)\b/;
/** The per-call opt-out, written on the line above. */
const OPT_OUT = /REPO-TREE-WRITE OK:/;

/** Calls that BUILD a path. An initializer that is not one of these is not a path. */
const PATH_BUILDERS = new Set([
  "join", "resolve", "normalize", "relative", "dirname", "fileURLToPath", "toNamespacedPath",
]);

/**
 * Does this initializer produce a PATH, as opposed to some other value that merely mentions
 * a path somewhere inside it?
 *
 * This distinction is what keeps the derivation below from running away. Measured while
 * writing the guard: `const result = await runPluginCommand(cmd, { cwd: process.cwd() })`
 * mentions a repo anchor, so a text-only rule anchors `result`; `const plan =
 * parsePluginLoopPlan(result.stdout)` then anchors `plan`; and `plan` matches inside the
 * STRING `"plan.json"`, so `const planFile = join(dir, "plan.json")` — a genuine temp path —
 * came out as an offender. Three false positives from one option-bag mention.
 */
function isPathExpression(init: ts.Expression): boolean {
  const expr = unwrapExpression(init);
  if (ts.isStringLiteral(expr) || ts.isTemplateExpression(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return true;
  if (ts.isIdentifier(expr) || ts.isPropertyAccessExpression(expr)) return true;
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) return true;
  if (ts.isCallExpression(expr)) {
    const callee = calleeName(expr);
    return callee !== null && PATH_BUILDERS.has(callee);
  }
  return false;
}

/** The identifiers appearing in an expression — NOT the words inside its string literals. */
function identifiersIn(expr: ts.Node): Set<string> {
  const out = new Set<string>();
  forEachNode(expr, (node) => {
    if (ts.isIdentifier(node)) out.add(node.text);
  });
  return out;
}

/**
 * Names bound in this file to a repo-anchored PATH — `const REPO_ROOT = resolve(import.meta.dirname, "../../..")`.
 *
 * Without this the guard would only catch a write that spells the anchor inline, and the one
 * real offender this repo had (#814) spelled it through a const declared 40 lines up.
 *
 * A name is repo-anchored when its initializer is a path expression that either names an
 * anchor directly or is built from an already-anchored name. A name whose initializer mentions
 * a temp anchor is never collected — `const dir = mkdtempSync(join(tmpdir(), ...))` is exactly
 * the shape this guard wants people to use — and neither is a name declared ANYWHERE in the
 * file with a temp initializer, because these are file-wide names and `dir` is routinely
 * re-declared per test.
 */
function repoAnchoredNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const tempNames = new Set<string>();
  forEachNode(sf, (node) => {
    if (!ts.isVariableDeclaration(node) || !node.initializer || !ts.isIdentifier(node.name)) return;
    if (TMP_ANCHOR.test(node.initializer.getText(sf))) tempNames.add(node.name.text);
  });
  // Two passes: a const can be defined in terms of an earlier one (SERVER_ROOT from REPO_ROOT).
  for (let pass = 0; pass < 2; pass++) {
    forEachNode(sf, (node) => {
      if (!ts.isVariableDeclaration(node) || !node.initializer || !ts.isIdentifier(node.name)) return;
      if (tempNames.has(node.name.text)) return;
      if (!isPathExpression(node.initializer)) return;
      const init = node.initializer.getText(sf);
      if (TMP_ANCHOR.test(init)) return;
      const ids = identifiersIn(node.initializer);
      const derived = [...ids].some((id) => names.has(id));
      if (REPO_ANCHOR.test(init) || derived) names.add(node.name.text);
    });
  }
  return names;
}

interface Offender {
  file: string;
  line: number;
  text: string;
}

/**
 * Which argument holds the DESTINATION. For the copy/move family it is the second — flagging
 * the first would fail every test that copies a fixture OUT of the repo into a temp dir, which
 * is a read of the tree and entirely fine.
 */
const DEST_ARG_INDEX: Record<string, number> = {
  renameSync: 1, rename: 1, copyFileSync: 1, copyFile: 1, cpSync: 1, cp: 1,
};

function scanFile(absFile: string): Offender[] {
  const sf = parseGuardSource(absFile);
  const anchored = repoAnchoredNames(sf);
  const out: Offender[] = [];
  forEachNode(sf, (node) => {
    if (!ts.isCallExpression(node)) return;
    const name = calleeName(node);
    if (!name || !WRITE_CALLS.has(name)) return;
    const target = node.arguments[DEST_ARG_INDEX[name] ?? 0];
    if (!target) return;
    const destExpr = unwrapExpression(target);
    const dest = destExpr.getText(sf);
    if (TMP_ANCHOR.test(dest)) return;
    const ids = identifiersIn(destExpr);
    const hitsAnchor = REPO_ANCHOR.test(dest) || [...ids].some((id) => anchored.has(id));
    if (!hitsAnchor) return;
    if (OPT_OUT.test(leadingCommentText(sf, node))) return;
    out.push({
      file: path.relative(REPO_ROOT, absFile).split(path.sep).join("/"),
      line: lineOf(sf, node),
      text: `${name}(${dest.replace(/\s+/g, " ")})`,
    });
  });
  return out;
}

/**
 * Every file that runs as part of a test: the `*.test.*` files anywhere in the package, PLUS
 * everything else under a `__tests__` directory.
 *
 * `walkTestFiles` alone would scan only the former, and the helpers are where a write is most
 * likely to be hidden and least likely to be reviewed — a fixture builder called from twelve
 * suites is exactly the shape that leaks into the tree twelve times a run.
 */
function testScopeFiles(packageDir: string): string[] {
  return walkPackageSources(packageDir, {
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    includeTests: true,
    skipDirs: new Set(["node_modules", "dist", "coverage", ".git"]),
  }).filter((f) => {
    const rel = f.split(path.sep).join("/");
    return rel.includes("/__tests__/") || /\.test\.[a-z]+$/.test(path.basename(f));
  });
}

/** Every package that actually holds tests, so adding a package cannot silently escape the scan. */
function testRoots(): string[] {
  return fs
    .readdirSync(PACKAGES_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => path.join(PACKAGES_ROOT, e.name))
    .filter((dir) => fs.existsSync(path.join(dir, "package.json")));
}

describe("tests never write into the real repo tree (#680)", () => {
  const roots = testRoots();

  it("the scan actually reaches the packages — a broken path must not read as 'clean'", () => {
    // A guard that silently scans nothing passes forever. Pin both halves: the packages are
    // found, and the walk over them yields the order of magnitude of test files this repo has.
    expect(roots.length).toBeGreaterThanOrEqual(4);
    const files = roots.flatMap((r) => testScopeFiles(r));
    expect(files.length).toBeGreaterThan(300);
    // ...and the widening past `*.test.*` is not vacuous: the helpers a suite calls are where
    // a write hides best, so at least one non-test file under a `__tests__` tree must be in.
    const helpers = files.filter((f) => !/\.test\.[a-z]+$/.test(path.basename(f)));
    expect(helpers.length, "no __tests__ helper files in scope").toBeGreaterThan(0);
  });

  it("no test writes to a repo-anchored path", () => {
    const offenders = roots.flatMap((r) => testScopeFiles(r)).flatMap(scanFile);
    expect(
      offenders.map((o) => `${o.file}:${o.line} -> ${o.text}`),
      "A test wrote into this checkout. Under `pnpm test:mine` the repo-scanning guard suites " +
        "(`@gate:always-run`) walk the tree while this runs, so a file appearing or a tracked " +
        "file changing mid-run makes THEM red — a load-dependent failure with no code " +
        "regression behind it, which is #680. It also dirties a checkout several agents share, " +
        "and the board withholds every merge while a tracked file is dirty (#814).\n\n" +
        // TEMP-PREFIX OK: `"..."` is a placeholder inside this assertion's advice text.
        'Write into `mkdtempSync(join(tmpdir(), "..."))` instead. If the real path is genuinely ' +
        "required, put `// REPO-TREE-WRITE OK: <reason>` on the line above the call.",
    ).toEqual([]);
  });

  it("the guard bites — the real #814 offender, and only it", () => {
    // A guard nobody has seen fail is indistinguishable from a no-op. Prove it on the ACTUAL
    // shape that leaked (`openapi-drift.test.ts` before its fix) rather than on a toy, and
    // prove the fixed shape beside it — a guard that flags everything is as useless as one
    // that flags nothing, and the three false positives this scan produced on its first run
    // were all of that second kind.
    const dir = mkdtempSync(join(tmpdir(), "ak-hermeticity-guard-"));
    try {
      const leaky = join(dir, "leaky.test.ts");
      writeFileSync(
        leaky,
        [
          'const REPO_ROOT = resolve(import.meta.dirname, "../../../..");',
          'const SPEC = join(REPO_ROOT, "packages/server/openapi.yaml");',
          "const original = readFileSync(SPEC, \"utf8\");",
          "try {",
          '  writeFileSync(SPEC, original.replace(/x/, "y"), "utf8");',
          "} finally {",
          '  writeFileSync(SPEC, original, "utf8");',
          "}",
        ].join("\n"),
        "utf8",
      );
      const leakyHits = scanFile(leaky);
      expect(leakyHits.length, "the pre-#814 shape must be caught").toBe(2);
      expect(leakyHits[0]!.text).toContain("writeFileSync(SPEC");

      const fixed = join(dir, "fixed.test.ts");
      writeFileSync(
        fixed,
        [
          'const REPO_ROOT = resolve(import.meta.dirname, "../../../..");',
          'const SPEC = join(REPO_ROOT, "packages/server/openapi.yaml");',
          // The line below is source text of a SYNTHESIZED fixture file that is never
          // executed, so no temp dir is ever created from that prefix — and renaming it
          // would change the very shape this guard's own bite test asserts on.
          // TEMP-PREFIX OK: synthesized fixture source, not a real mkdtemp call site.
          'const scratch = mkdtempSync(join(tmpdir(), "copy-"));',
          'const copy = join(scratch, "openapi.yaml");',
          '  writeFileSync(copy, readFileSync(SPEC, "utf8"), "utf8");',
          '  copyFileSync(SPEC, copy);',
          '  rmSync(scratch, { recursive: true, force: true });',
        ].join("\n"),
        "utf8",
      );
      expect(
        scanFile(fixed).map((o) => o.text),
        "the sanctioned shape — perturb a temp copy, and copy OUT of the repo — must not flag",
      ).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
