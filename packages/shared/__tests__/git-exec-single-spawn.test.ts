// @gate:always-run — scans the tree for raw git spawns outside the adapter; imports nothing it checks (#538).
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Architecture gate: the git CLI may be spawned from exactly ONE place —
 * `packages/shared/src/lib/git-exec.ts`, the sanctioned git adapter. Every other
 * module must go through its `gitExec` / `gitExecOrThrow` / `gitExecSync`
 * primitives instead of calling `child_process` on `git` directly.
 *
 * This keeps the Windows quirks (`windowsHide`), buffer limits, timeouts and error
 * normalisation in one adapter, and makes git a single replaceable boundary
 * (clean-architecture port). It also prevents the historical drift where ~17
 * services each grew their own private `execGit` helper while the docs claimed a
 * single source of truth.
 *
 * Why an AST gate, not a regex (arch-review #899): the old guard matched only a
 * string literal `git` immediately after the call paren. It was a spelling check,
 * not an architectural one — it missed `execFile(g, …)` with a variable bound to
 * `"git"`, `execFileSync(GIT_BIN, …)` with a const, the `promisify(execFile)`
 * indirection used elsewhere in the tree, and dynamic `import("node:child_process")`
 * destructures. ~20 files already import `node:child_process` for legitimate
 * non-git spawns (agent CLIs, dev servers, `taskkill`, `pnpm`, `mklink`, codex/claude
 * login), so we cannot simply ban the import. Instead we parse each file, find the
 * names actually bound to a `child_process` exec/spawn function (including aliases
 * via `promisify` and dynamic import), resolve each call's command argument through
 * local consts/variables, and flag it iff that command resolves to `git`. This
 * catches git invocations regardless of how the command string is spelled, while
 * leaving the legitimate non-git spawns alone.
 *
 * Scan surface (arch-review #17): we walk EVERY package directory (not just the
 * src subtree) and parse .ts AND .js/.mjs/.cjs files. The earlier gate scanned
 * only .ts files under packages/[pkg]/src, so the scaffold .js hook scripts and
 * the e2e global-setup.ts (which live outside src or carry a .js extension)
 * escaped by file-extension / location ACCIDENT rather than by an explicit
 * decision. Every legitimate raw-git spawn is now either routed through the
 * adapter or listed, with a justification, in ALLOWLIST below.
 *
 * Tests are excluded: they legitimately drive real git to build fixtures.
 */

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");

/**
 * The ONLY files allowed to spawn `git` via child_process, each an EXPLICIT,
 * JUSTIFIED decision (not an accident of the scan glob). Keys are paths relative
 * to REPO_ROOT; values document why the file cannot route through the adapter.
 */
const ALLOWLIST = new Map<string, string>([
  [
    join("packages", "shared", "src", "lib", "git-exec.ts"),
    "The sanctioned git adapter itself — the single spawn site every other module must go through.",
  ],
  [
    join("packages", "server", "src", "scaffold", "smart-hooks-runner.js"),
    "Standalone hook script scaffolded into OTHER repos' .claude/hooks/. Runs dependency-free in " +
      "arbitrary user projects where @agentic-kanban/shared is not on disk, so it cannot import the " +
      "adapter; it applies windowsHide itself. Must stay a self-contained .js (do not rewrite to import shared).",
  ],
  [
    join("packages", "server", "src", "scaffold", "vital-file-guard.js"),
    "Dependency-free scaffolded PreToolUse guard shipped into user repos' .claude/hooks/. Same rationale " +
      "as smart-hooks-runner: it must run standalone with no shared package available, so no adapter import.",
  ],
  [
    join("packages", "server", "src", "scaffold", "prevent-cross-worktree-writes.js"),
    "Dependency-free scaffolded PreToolUse guard shipped into user repos' .claude/hooks/. Runs standalone " +
      "in scaffolded repos (no @agentic-kanban/shared on disk), so it cannot import the adapter.",
  ],
  // #647 item 4: the repo's OWN `.claude/hooks/*.js` guards. Claude Code / Codex execute
  // each of these as a bare `node <file>` PreToolUse hook, with no bundler, no package
  // context and no guarantee that `packages/shared` is even built — several exist precisely
  // to run when the tree is in a bad state. Importing the adapter would make a safety guard
  // fail open exactly when it is most needed, so they spawn git themselves (with windowsHide)
  // and are listed here. Same standing rule as the scaffold copies: do not rewrite these to
  // import shared.
  [
    join(".claude", "hooks", "check-conflict-markers.js"),
    "Dependency-free PreToolUse hook run as bare `node <file>`; resolves the repo root and reads " +
      "the diff before shared may be built.",
  ],
  [
    join(".claude", "hooks", "check-skill-frontmatter.js"),
    "Dependency-free PreToolUse hook; reads skill files from the git INDEX (`git show :<path>`), " +
      "which the adapter's API does not change and which must work with no shared build.",
  ],
  [
    join(".claude", "hooks", "check-uncommitted.js"),
    "Dependency-free Stop hook; a single `git status --porcelain` that must run standalone.",
  ],
  [
    join(".claude", "hooks", "prevent-cross-worktree-writes.js"),
    "Dependency-free write guard; enumerates worktrees to decide whether a write escapes this " +
      "checkout. Must not depend on the tree it is protecting.",
  ],
  [
    join(".claude", "hooks", "require-read-before-write.js"),
    "Dependency-free write guard; resolves the repo root only.",
  ],
  [
    join(".claude", "hooks", "smart-hooks-runner.js"),
    "Dependency-free hook dispatcher — the .codex parity entry point too. The in-repo twin of " +
      "packages/server/src/scaffold/smart-hooks-runner.js, allowlisted above for the same reason.",
  ],
  [
    join(".claude", "hooks", "validate-command-safety.js"),
    "Dependency-free PreToolUse guard — the one that blocks kanban.db destruction. It must run " +
      "even when the checkout is broken, so it cannot import anything from packages/.",
  ],
  [
    join(".claude", "hooks", "vital-file-guard.js"),
    "Dependency-free PreToolUse guard shielding vital files; in-repo twin of the scaffold copy.",
  ],
  [
    join("scripts", "shared-preflight.mjs"),
    "Runs `git restore packages/shared` when packages/shared looks WIPED — importing the adapter " +
      "from the package it is repairing is exactly the thing that cannot work here.",
  ],
  [
    join("packages", "server", "scripts", "generate-bundled-skill.mjs"),
    "Bundled-skill generator, run as a bare `node <file>` (pnpm skill:generate / skill:check) and " +
      "from the freshness gate itself. It must work with packages/shared UNBUILT — the tree it " +
      "stamps is the one where shared may be mid-change — so it cannot import the adapter, whose " +
      "deep path resolves to TS source that plain node will not load. One read-only " +
      "`git rev-parse --short HEAD` for the `commit:` stamp, with windowsHide, degrading to " +
      "\"unknown\" on any failure.",
  ],
  [
    join("packages", "e2e", "global-setup.ts"),
    "Playwright global-setup — test-harness bootstrap that resolves the repo root (a single read-only " +
      "`git rev-parse --git-common-dir`) before the app runs. Morally test infrastructure; the " +
      ".test.ts/.spec.ts exclusion simply does not name it.",
  ],
  [
    join("scripts", "test-mine.mjs"),
    "The test runner itself, run as bare `node scripts/test-mine.mjs` with no bundler and no tsx " +
      "— so it cannot import the adapter, which is TypeScript under packages/shared/src, and it " +
      "must keep working while packages/shared is mid-change, since running the tests is how you " +
      "find out. One read-only `git status --porcelain -z` snapshotted before and after the run " +
      "(#680): a suite that writes into the checkout is what makes the repo-scanning guard suites " +
      "see a moving tree under parallelism, and the runner is the only place that can observe it. " +
      "windowsHide, stderr ignored, returns null on any failure rather than throwing.",
  ],
  [
    join("scripts", "measure-package-coupling.mjs"),
    "Standalone measurement script (#730) run as bare `node scripts/measure-package-coupling.mjs`, " +
      "with no bundler and no tsx — so it cannot import the adapter, which is TypeScript under " +
      "packages/shared/src. One read-only `git log` over the whole history; it is committed so the " +
      "cross-package coupling verdict is REBUILDABLE rather than a number in a doc, which is the " +
      "point of keeping it. Same rationale as the .claude/hooks entries above: dependency-free by " +
      "necessity, not by accident.",
  ],
]);

/** Source file extensions the gate parses. `.js`/`.mjs`/`.cjs` added in #17 so scaffold hook scripts are visible. */
const SOURCE_EXTENSIONS = [".ts", ".js", ".mjs", ".cjs"];

/** child_process functions that actually launch a process given a command/file as arg 0. */
const SPAWN_FNS = new Set(["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync"]);

/** Command values that mean "the git CLI". */
const GIT_COMMANDS = new Set(["git", "git.exe"]);

/**
 * Directory names that are never scanned, matched against the path RELATIVE to
 * REPO_ROOT.
 *
 * Relative, not absolute (#58/#64): worktrees live at `<parent>/.worktrees/<branch>/`,
 * so inside one, REPO_ROOT itself contains `.worktrees` as a path part. Splitting the
 * ABSOLUTE path therefore matched the root prefix and excluded EVERY file in the tree —
 * the scan silently asserted nothing (a vacuous pass) in every worktree, which is where
 * agents actually work. Matching the relative path keeps the exclusion doing its real
 * job (skipping a worktree nested INSIDE the repo) without the root prefix aliasing it.
 */
/**
 * `__tests__` covers `__tests__/helpers/` too, and #647 item 4 listed that as a bypass.
 * Kept deliberately: a helper is extracted TEST code, and the exclusion's stated reason —
 * tests legitimately drive real git to build fixtures — applies to it identically. The
 * only thing moving a fixture builder from a `.test.ts` into `helpers/` would change is
 * whether the gate shouts about it, which is not a property worth gating on. The real
 * scope gap was the repo-root trees, fixed in collectAllPackageSources below.
 */
const EXCLUDED_DIRS = ["node_modules", "dist", ".worktrees", "__tests__"];

function isExcluded(absPath: string): boolean {
  const parts = relative(REPO_ROOT, absPath).split(sep);
  return (
    parts.some((part) => EXCLUDED_DIRS.includes(part)) ||
    /\.(test|spec)\.(ts|js|mjs|cjs)$/.test(absPath)
  );
}

function collectSourceFiles(dir: string, out: string[]): void {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (isExcluded(full)) continue;
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out);
    } else if (SOURCE_EXTENSIONS.some((ext) => full.endsWith(ext))) {
      out.push(full);
    }
  }
}

type Offender = { line: number; snippet: string };

/** Unwrap parentheses / `as` / `satisfies` / non-null wrappers around an expression. */
function unwrap(node: ts.Expression): ts.Expression {
  let cur = node;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isNonNullExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

/** Resolve an expression to a concrete string, if it is statically one. Returns null otherwise. */
function resolveString(expr: ts.Expression, consts: Map<string, string>): string | null {
  const node = unwrap(expr);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) return consts.get(node.text) ?? null;
  return null;
}

/**
 * The PROGRAM a command expression launches, when that much is statically known (#647 item 4).
 *
 * `resolveString` deliberately answers "is this expression exactly this string", and a template
 * literal with a substitution — `` exec(`git log ${ref}`) `` — is not, so it returned null and
 * the call passed the gate. That is a real bypass and the most natural way to write a dynamic
 * git command. But the gate never needs the whole string: only the first token, the binary.
 *
 * So for a `TemplateExpression` we read the literal HEAD and take its first token. `` `git
 * ${args}` `` → "git" (flagged); `` `${bin} status` `` → an empty head → no token → not flagged,
 * which is the correct answer rather than a guess. Kept separate from `resolveString` so the
 * const map is never poisoned with a partially-resolved value.
 */
function resolveCommandProgram(expr: ts.Expression, consts: Map<string, string>): string | null {
  const node = unwrap(expr);
  const whole = resolveString(node, consts);
  const head = whole ?? (ts.isTemplateExpression(node) ? node.head.text : null);
  if (head == null) return null;
  const program = head.trim().split(/\s+/, 1)[0];
  return program === "" ? null : program;
}

/**
 * Does this require/import specifier point at node's child_process?
 * Matches `"child_process"` and `"node:child_process"`.
 */
function isChildProcessModule(spec: string): boolean {
  return spec === "child_process" || spec === "node:child_process";
}

/**
 * Parse one source file and return any line that spawns `git` through a
 * child_process function, however the command string is spelled.
 */
function findGitSpawns(filePath: string, text: string): Offender[] {
  const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, /*setParentNodes*/ true, ts.ScriptKind.TS);
  const offenders: Offender[] = [];

  // Pass 1: collect string-valued const/let/var bindings (`const GIT = "git"`),
  // names bound to a child_process spawn fn (direct import, dynamic import, or
  // `promisify(execFile)` alias), and the set of spawn-fn local names.
  const stringConsts = new Map<string, string>();
  const spawnNames = new Set<string>();

  // Seed with default child_process binding names so `cp.execFile(...)` is caught too.
  const namespaceImports = new Set<string>();

  function bindFromModuleImport(name: string, imported: string): void {
    if (SPAWN_FNS.has(imported)) spawnNames.add(name);
  }

  function visitCollect(node: ts.Node): void {
    // `import { execFile, spawn as sp } from "node:child_process"`
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (isChildProcessModule(node.moduleSpecifier.text)) {
        const clause = node.importClause;
        const named = clause?.namedBindings;
        if (named && ts.isNamedImports(named)) {
          for (const el of named.elements) {
            bindFromModuleImport(el.name.text, (el.propertyName ?? el.name).text);
          }
        }
        if (named && ts.isNamespaceImport(named)) {
          namespaceImports.add(named.name.text); // `import * as cp from "child_process"`
        }
      }
    }

    // Variable declarations: string consts, dynamic-import destructures, promisify aliases.
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!decl.initializer) continue;
        const init = unwrap(decl.initializer);

        // `const GIT = "git"` / `const GIT_BIN = "git" as const`
        if (ts.isIdentifier(decl.name)) {
          const s = resolveString(decl.initializer, stringConsts);
          if (s != null) stringConsts.set(decl.name.text, s);

          // `const execFileAsync = promisify(execFile)`
          if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "promisify") {
            const arg = init.arguments[0];
            if (arg && ts.isIdentifier(arg) && spawnNames.has(arg.text)) {
              spawnNames.add(decl.name.text);
            }
          }

          // `const cp = require("child_process")` / `= await import("node:child_process")`
          const mod = requireOrImportModule(init);
          if (mod && isChildProcessModule(mod)) namespaceImports.add(decl.name.text);
        }

        // `const { execFile } = await import("node:child_process")`
        // `const { execFile: ef } = require("child_process")`
        if (ts.isObjectBindingPattern(decl.name)) {
          const mod = requireOrImportModule(init);
          if (mod && isChildProcessModule(mod)) {
            for (const el of decl.name.elements) {
              if (ts.isIdentifier(el.name)) {
                const imported = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
                bindFromModuleImport(el.name.text, imported);
              }
            }
          }
        }
      }
    }

    ts.forEachChild(node, visitCollect);
  }

  /** Extract the module specifier from `require("x")`, `import("x")`, or `await import("x")`. */
  function requireOrImportModule(expr: ts.Expression): string | null {
    let node = unwrap(expr);
    if (ts.isAwaitExpression(node)) node = unwrap(node.expression);
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      if ((isRequire || isImport) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        return node.arguments[0].text;
      }
    }
    return null;
  }

  visitCollect(sf);

  // Pass 2: find calls to a spawn fn (by name, alias, or `cp.execFile`) whose
  // command argument resolves to git.
  function calleeIsSpawn(callee: ts.Expression): boolean {
    const c = unwrap(callee);
    if (ts.isIdentifier(c)) return spawnNames.has(c.text);
    // `cp.execFile(...)` / `(await import(...)).execFile(...)`
    if (ts.isPropertyAccessExpression(c) && SPAWN_FNS.has(c.name.text)) {
      const obj = unwrap(c.expression);
      if (ts.isIdentifier(obj) && namespaceImports.has(obj.text)) return true;
      // `require("child_process").execFile(...)` inline
      const mod = requireOrImportModule(obj);
      if (mod && isChildProcessModule(mod)) return true;
    }
    return false;
  }

  function visitCalls(node: ts.Node): void {
    if (ts.isCallExpression(node) && calleeIsSpawn(node.expression)) {
      const arg0 = node.arguments[0];
      if (arg0) {
        // For `exec`/`execSync` the whole shell command line is arg0 (e.g.
        // `exec("git status")`), so the program is the FIRST whitespace token.
        // For `execFile`/`spawn` arg0 is already just the binary. Taking the
        // first token works for both and never widens to a false positive.
        const program = resolveCommandProgram(arg0, stringConsts);
        if (program != null && GIT_COMMANDS.has(program)) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          offenders.push({ line: line + 1, snippet: lineTextAt(text, line) });
        }
      }
    }
    ts.forEachChild(node, visitCalls);
  }

  visitCalls(sf);
  return offenders;
}

/** 0-based line index → trimmed source line. */
function lineTextAt(text: string, lineIndex: number): string {
  return text.split(/\r?\n/)[lineIndex]?.trim() ?? "";
}

describe("git-exec single-spawn gate", () => {
  it("flags a raw git spawn via a variable, a const, and helper indirection", () => {
    const source = [
      `import { execFile, execFileSync, spawn } from "node:child_process";`,
      `import { promisify } from "node:util";`,
      `const GIT_BIN = "git";`,
      `const g = "git" as const;`,
      `const execFileAsync = promisify(execFile);`,
      `execFileSync(GIT_BIN, ["status"]);`, // const indirection
      `spawn(g, ["log"]);`, // variable indirection
      `execFileAsync("git", ["diff"]);`, // promisify alias
    ].join("\n");

    const offenders = findGitSpawns("sample.ts", source);
    expect(offenders.map((o) => o.line)).toEqual([6, 7, 8]);
  });

  it("flags the `exec`/`execSync` shell-string form where the whole command line is arg0", () => {
    const source = [
      `import { exec, execSync } from "node:child_process";`,
      `const GIT_CMD = "git rev-parse HEAD";`,
      `execSync("git status --porcelain", { cwd });`, // literal shell command
      `exec(GIT_CMD, () => {});`, // const-resolved shell command
    ].join("\n");

    const offenders = findGitSpawns("sample.ts", source);
    expect(offenders.map((o) => o.line)).toEqual([3, 4]);
  });

  it("flags a template literal WITH substitution — the most natural dynamic git call (#647)", () => {
    // The bypass: `resolveString` answers "is this exactly this string", and an interpolated
    // template is not, so it returned null and every one of these passed the gate silently.
    const source = [
      "import { exec, execSync, execFile } from \"node:child_process\";",
      "execSync(`git log ${ref}`);",
      "exec(`git diff --stat ${a}..${b}`, () => {});",
      "execFile(`git`, [`log`, ref], () => {});",
    ].join("\n");

    expect(findGitSpawns("sample.ts", source).map((o) => o.line)).toEqual([2, 3, 4]);
  });

  it("does NOT guess when the binary itself is the substitution", () => {
    // `` `${bin} status` `` has an empty head, so no program is known. Refusing to answer is
    // correct here — flagging it would be a guess, and one that fires on every dynamic spawn.
    const source = [
      "import { execSync } from \"node:child_process\";",
      "execSync(`${bin} status`);",
      "execSync(`${pnpm} run build`);",
    ].join("\n");

    expect(findGitSpawns("sample.ts", source)).toEqual([]);
  });

  it("does not flag legitimate non-git spawns (pnpm, taskkill, where claude)", () => {
    const source = [
      `import { execSync, execFile, spawn } from "node:child_process";`,
      `execSync("where claude.exe 2>nul");`,
      `execFile("taskkill", ["/PID", "1", "/F"], () => {});`,
      `function run(command: string, args: string[]) { spawn(command, args); }`, // unresolvable param
      `const cmd = "pnpm"; spawn(cmd, ["build"]);`,
    ].join("\n");

    expect(findGitSpawns("sample.ts", source)).toEqual([]);
  });

  it("catches a multiline call and a `git` command split onto the next line", () => {
    const source = `import { execFileSync } from "node:child_process";\nconst output = execFileSync(\n  "git",\n  ["status"],\n);`;
    const offenders = findGitSpawns("sample.ts", source);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]?.line).toBe(2); // the call expression starts on line 2
  });

  /**
   * Every .ts/.js/.mjs/.cjs source file the gate governs, minus the isExcluded set.
   *
   * `packages/` plus the two repo-root trees that actually run code (#647 item 4): the
   * scan was packages-only, so 8 live `.claude/hooks/*.js` guards and
   * `scripts/shared-preflight.mjs` spawned git completely unseen — the gate reported a
   * single spawn site while nine others sat outside its glob. They are allowlisted
   * rather than rewritten (see ALLOWLIST for why each must stay standalone), but the
   * point is that they are now VISIBLE and each is an explicit decision.
   */
  function collectAllPackageSources(): string[] {
    const packagesDir = join(REPO_ROOT, "packages");
    const files: string[] = [];
    for (const pkg of readdirSync(packagesDir)) {
      if (pkg === ".worktrees") continue;
      // Walk the WHOLE package dir (not just src/) so files outside src — e.g.
      // packages/e2e/global-setup.ts and the scaffold .js hook scripts — are visible.
      collectSourceFiles(join(packagesDir, pkg), files);
    }
    for (const rootTree of [join(".claude", "hooks"), "scripts"]) {
      collectSourceFiles(join(REPO_ROOT, rootTree), files);
    }
    return files;
  }

  it("the scan is not vacuous — it reaches the real package tree", () => {
    // The gate's own smoke test. Every assertion below is a `.toEqual([])` over the
    // scan's output, so a scan that reaches ZERO files passes them ALL while proving
    // nothing — which is exactly how #58 hid: the exclusion aliased the worktree
    // REPO_ROOT prefix and dropped all 1000+ files, and the suite stayed green.
    // Pin the floor here so an over-broad exclusion fails loudly instead of silently
    // disarming the gate. The count is a floor, not a fixture — it needs no upkeep as
    // files are added.
    const files = collectAllPackageSources();
    expect(files.length, "scan reached no files — the gate is disarmed").toBeGreaterThan(100);
    expect(
      files.some((f) => f.endsWith(join("src", "lib", "git-exec.ts"))),
      "scan did not reach the adapter itself — the gate is disarmed",
    ).toBe(true);
    // #647 item 4: the two repo-root trees. Nine live git spawns sat in them, invisible,
    // while this gate claimed a single spawn site — so assert the reach, don't assume it.
    for (const tree of [join(".claude", "hooks"), "scripts"]) {
      expect(
        files.some((f) => f.startsWith(join(REPO_ROOT, tree))),
        `scan did not reach ${tree}/ — the gate is blind there again`,
      ).toBe(true);
    }
  });

  it("no package source spawns git outside the git-exec adapter", () => {
    const files = collectAllPackageSources();

    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(REPO_ROOT, file);
      if (ALLOWLIST.has(rel)) continue;
      const text = readFileSync(file, "utf8");
      for (const off of findGitSpawns(file, text)) {
        offenders.push(`${rel}:${off.line}  ${off.snippet}`);
      }
    }

    expect(
      offenders,
      `These files spawn git directly instead of importing the adapter from ` +
        `@agentic-kanban/shared/lib/git-exec (route them through it, or if they must stay ` +
        `standalone add a justified ALLOWLIST entry):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("every ALLOWLIST entry is live — the file exists, is reached by the scan, and really spawns git", () => {
    // Guards against the allowlist silently going stale: if the scan glob/roots ever
    // narrow so an allowlisted file is no longer scanned, or the file stops spawning
    // git (and should be de-listed), this fails instead of granting a dead exemption.
    const scanned = new Set(collectAllPackageSources().map((f) => relative(REPO_ROOT, f)));
    for (const rel of ALLOWLIST.keys()) {
      expect(scanned.has(rel), `allowlisted file is not reached by the scan: ${rel}`).toBe(true);
      const text = readFileSync(join(REPO_ROOT, rel), "utf8");
      expect(
        findGitSpawns(rel, text).length,
        `allowlisted file no longer spawns git (de-list it): ${rel}`,
      ).toBeGreaterThan(0);
    }
  });
});
