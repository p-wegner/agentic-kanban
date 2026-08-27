// @gate:always-run — walks every package's src tree plus `scripts/` and reads `docs/env-vars.md`;
// it imports none of the files it judges.
/**
 * Every `process.env` read has a known OWNER (#707).
 *
 * #615 turned seven renamed variables into data (`KANBAN_ENV`) and pinned them against
 * `docs/env-vars.md`. But that pairing was a closed loop over those seven: the parity test
 * asks "is every REGISTERED var documented", which nothing outside the registry can fail.
 * Meanwhile 84 bare `process.env.<NAME>` reads across 42 distinct names sat outside it —
 * 21 of them `KANBAN_*`, i.e. board-owned by the page's own naming rule and documented
 * nowhere — and no rule forbade an 85th. The doc said as much in a caveat.
 *
 * This is the rule that replaces the caveat, and it is an ownership question rather than a
 * documentation one, because "who does this variable belong to?" is what an unprefixed name
 * in an agent's spawn env genuinely cannot answer:
 *
 *   - **board-owned** (`KANBAN_*`, `AGENTIC_KANBAN_*`) — must have a ROW in
 *     `docs/env-vars.md`. Zero tolerance: the page is the inventory, so a board var missing
 *     from it is the exact defect #707 describes.
 *   - **foreign** (the OS, Node, an agent CLI, a build tool) — must be declared in `FOREIGN`
 *     below with a note on whose it is. Not documented as ours, but not anonymous either.
 *
 * Deliberately NOT a grandfathered baseline of shame. A frozen "these 10 are undocumented"
 * set is a budget: it goes green while the debt sits there, and the next reader cannot tell
 * a deliberate exemption from an unpaid one. Both categories here are answerable today, so
 * the gate asks for the answer.
 *
 * ## #734 — three ways this guard was blind, and why they mattered
 *
 * The predicate was one regex over source TEXT matching `process.env.NAME` and
 * `process.env["NAME"]`. Three consequences, all measured:
 *
 *  1. **Its coverage SHRANK as the code improved.** The repo's direction of travel is
 *     `const env = process.env` at a module edge and `env.NAME` at the read — 34 live sites
 *     already did that, and every one was invisible. A ratchet whose reach retreats ahead of
 *     the refactor it wants is worse than none: it goes green *because* the code moved.
 *  2. **Single-quoted `process.env['NAME']` escaped**, for no reason but the regex spelling
 *     one of two identical forms.
 *  3. **`scripts/` was not scanned at all** (the roots were four `packages/<pkg>/src` dirs), so
 *     `KANBAN_TEST_GUARDS_ONLY` — read by `scripts/test-mine.mjs`, the script this very gate
 *     runs through — was board-prefixed and documented nowhere, and `ACP_CLI` was an
 *     undeclared foreign name.
 *
 * The scan is therefore an AST walk over the shared typed guard layer
 * (`parseGuardSource`/`forEachNode`, #721) which tracks the ALIAS BINDING: a variable
 * initialised from `process.env` makes every `alias.NAME` / `alias["NAME"]` on it a read, and
 * `const { NAME } = process.env` counts too. Both quote styles are one code path, and a
 * computed key (`process.env[expr]`) is pinned separately rather than silently dropped.
 *
 * And "documented" now means a **table row**, not a mention. It used to be
 * ``doc.includes("`NAME`")``, which any backticked occurrence in prose satisfied — including
 * this page's own paragraphs about undocumented variables, so a var could be documented by the
 * sentence saying it must be. {@link docRowNames} reads the first cell of every markdown table
 * row instead, which is where the inventory actually lives.
 *
 * ## #768 — a name passed to a HELPER was still invisible, and two board vars proved it
 *
 * After #734 the scan saw every DIRECT syntactic form: `process.env.NAME`, `env.NAME`,
 * `process.env["NAME"]`, destructuring. What it did not see is a name in ARGUMENT position:
 *
 *     envPort("KANBAN_FLEET_PORT", { fallback: null, … })
 *
 * The read happens inside `envPort` as `env[name]`, which lands in the `computed` bucket —
 * and that bucket was merely CAPPED at a count. A cap answers "how many reads can we not
 * see?"; it never answers "which variable was that?". So `KANBAN_FLEET_PORT` and
 * `KANBAN_GIT_HTTP_PORT` — both board-prefixed, both operator-facing, both required to run a
 * fleet — reached master with no row on the inventory page and no complaint from the guard
 * that exists to make the page's completeness claim true. Their rows were added by hand under
 * #756; the guard was untouched.
 *
 * Same failure shape as #721 and #734 once more: a guard that can only catch the REUSE of a
 * form somebody already used. Two changes:
 *
 *  1. **{@link ENV_READER_HELPERS}** — a call to a known env-reader helper with a STRING
 *     LITERAL in its name position is resolved into a named read and checked against the doc
 *     page exactly like a direct one. The helpers are enumerated, not guessed: they are the
 *     functions behind the dynamic reads below.
 *  2. **{@link DYNAMIC_ENV_READS}** — the `computed` bucket is a named, reasoned per-site
 *     allowlist keyed by `<file>::<key expression>` instead of a bare number. Each entry says
 *     which names the site can resolve to and why the indirection is right there. Keyed by
 *     the key EXPRESSION rather than a line number so an unrelated edit above it does not
 *     invalidate the reason.
 *
 * The baseline was deliberately NOT driven to zero. `env[name]` inside `envPort` is the
 * correct implementation of a helper, and `readBoardEnv` must read `entry.legacyAlias`
 * dynamically to honour a rename; forcing those out would push the pattern into a shape the
 * scanner also cannot see, which is worse than a documented bucket.
 *
 * Scope is every package's `src` tree plus `scripts/`, excluding tests: a suite setting
 * `process.env.KANBAN_TEST_*` to drive its own fixture is not making a claim about the
 * product's configuration surface.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  walkPackageSources,
  parseGuardSource,
  forEachNode,
  lineOf,
  unwrapExpression,
} from "../../../shared/__tests__/helpers/guard-scan.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/**
 * Every tree whose env reads are part of the board's configuration surface, relative to the
 * repo root. `scripts/` is here since #734: a variable the board's own build/test scripts read
 * is as much part of that surface as one a service reads, and two names escaped for exactly
 * that reason. `packages/desktop/src` holds no TypeScript today (the Tauri shell is Rust) — it
 * is listed so adding one does not silently reopen the same hole, and `walkPackageSources`
 * returns `[]` for a missing directory rather than throwing.
 */
const SCAN_ROOTS = [
  "packages/shared/src",
  "packages/server/src",
  "packages/client/src",
  "packages/mcp-server/src",
  "packages/desktop/src",
  "scripts",
];

/** `.mjs`/`.js` are in the list because `scripts/` is written in them. */
const SCAN_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js"];

const BOARD_PREFIXES = ["KANBAN_", "AGENTIC_KANBAN_"];

/**
 * Variables the board READS but does not OWN THE NAME OF, each with whose they are. A name here is a
 * claim that renaming it is not ours to do — which is the same argument `docs/env-vars.md`
 * makes for the scaffold guards' variables, written where a test can check it.
 *
 * Only what is ACTUALLY read under a scanned root, which the stale-entry test below enforces.
 * It is therefore shorter than the "third-party and OS" bullet on the doc page, and
 * deliberately so: most `ANTHROPIC_*`/`CODEX_*` names reach an agent through a spawn-env
 * OBJECT built by `buildSpawnEnv`, never through a direct read here, and listing those would
 * be a claim this suite cannot check.
 */
const FOREIGN: Record<string, string> = {
  // OS / shell
  PATH: "OS — executable search path, used to resolve an agent CLI",
  PATHEXT: "Windows — the extensions that make a file executable (.EXE/.CMD/.BAT/.PS1)",
  APPDATA: "Windows — roaming app data, where a global npm install puts its bin",
  LOCALAPPDATA: "Windows — local app data, a candidate Node install location",
  ProgramFiles: "Windows — a candidate Node install location",
  "ProgramFiles(x86)": "Windows — the 32-bit program dir, the other candidate Node install location",
  // Node runtime / toolchain conventions
  UV_THREADPOOL_SIZE: "libuv — the board raises it when unset; documented under Runtime tuning",
  NODE_ENV: "Node convention — production/development mode; the doc page lists it as a runner convention",
  VITEST: "vitest — set inside a vitest worker; the doc page lists it as a runner convention",
  npm_execpath: "npm/pnpm — the package manager that invoked us, so a re-invocation uses the same one",
  // Agent CLIs: their config roots. Renaming any of these would break the CLI, not us.
  CLAUDE_CONFIG_DIR: "Claude Code — its config root; the board reads it to find session state",
  CODEX_HOME: "Codex CLI — its config/credential root; worker doctor consults it for provider login (#875)",
  CLAUDE_PROJECT_DIR: "Claude Code — the repo root it sets for hook execution; a scaffolded hook self-locates with it",
  PI_CODING_AGENT_DIR: "Pi — its config/credential root",
  // Other tools the board shells out to
  DOCKER_HOST: "Docker — the daemon endpoint; named on the doc page's third-party bullet",
  ACP_CLI: "the ACP blob CLI (a separate tool) — where `scripts/pack-worker.mjs` finds it",
  IS_SANDBOX: "Claude Code / the board's own container image — set BY the sandbox, read to detect one",
  /*
   * The `scaffold/` guards' variables. These are board-authored but NOT board-renameable:
   * the hook scripts ship INTO other people's repos, so renaming them is a separate decision
   * with its own upgrade story (`docs/env-vars.md`, "Not renamed, and why"). That page already
   * names all five and says explicitly that FOREIGN — not the bullet — is what the gate checks,
   * so this is where they belong. They became visible to this guard only in #734, when the scan
   * started reading `.js` sources: the scaffold hooks are plain JS.
   */
  ALLOW_CROSS_WORKTREE_WRITE: "scaffold hook contract — the escape hatch of the cross-worktree write guard, frozen for scaffolded checkouts",
  ALLOW_VITAL_DESTROY: "scaffold hook contract — the escape hatch of the vital-file guard, frozen for scaffolded checkouts",
  VITAL_FILES: "scaffold hook contract — which files the vital-file guard protects, frozen for scaffolded checkouts",
  VERIFY_GATE_COMMAND: "scaffold hook contract — the verify command the gate runner invokes, frozen for scaffolded checkouts",
  VERIFY_GATE_MAX_REPAIR_ATTEMPTS: "scaffold hook contract — repair-attempt cap in the gate runner, frozen for scaffolded checkouts",
  SMART_HOOKS_FORCE: "capacity hook/server compatibility — legacy force switch shared with the existing smart-hooks heuristic",
  SMART_HOOKS_MIN_FREE_GB: "capacity hook/server compatibility — legacy memory floor shared with the existing smart-hooks heuristic",
  // Ports the ecosystem already names. Renaming them would break every convention that sets them.
  PORT: "hosting convention — the server port when no KANBAN_* port is set",
  VITE_PORT: "Vite convention",
  SERVER_PORT: "pre-KANBAN_ port name, still honoured; see docs/env-vars.md",
  DB_URL: "the #615 legacy alias of KANBAN_DB_URL, read through readBoardEnv",
};

/**
 * Functions that read an environment variable whose NAME is their argument, and which
 * argument that is (#768). A literal in that position IS a named read: the variable is as
 * much part of the board's configuration surface as one spelled `process.env.NAME`, and
 * `KANBAN_FLEET_PORT` / `KANBAN_GIT_HTTP_PORT` reaching master undocumented is what happens
 * when it is not treated as one.
 *
 * Enumerated from the dynamic reads in {@link DYNAMIC_ENV_READS}, not guessed: a helper is on
 * this list precisely because its body appears there. `readBoardEnv` also throws on a name
 * that is not in `KANBAN_ENV`, so its arguments are doubly constrained — but the doc-row check
 * is what this suite is for, and #615's registry parity is a different assertion.
 */
const ENV_READER_HELPERS: Record<string, number> = {
  envPort: 0,
  readBoardEnv: 0,
};

/**
 * The reads whose KEY is an expression, keyed `<file>::<key expression>` (#768).
 *
 * This replaced `DYNAMIC_READ_BASELINE = 5`. A count is the wrong instrument: it says how many
 * reads are invisible and never which variable, so a brand-new undocumented board variable was
 * free as long as the total held. Each entry below states the names the site can resolve to,
 * which is the fact a reader actually needs, and the stale-entry half means a site that goes
 * away takes its exemption with it.
 *
 * Keyed by the key EXPRESSION rather than a line number on purpose: a reason pinned to
 * `bearer-token.ts:156` is invalidated by any edit above it, and a ratchet that churns on
 * unrelated edits gets bumped rather than read.
 */
const DYNAMIC_ENV_READS: Record<string, string> = {
  "packages/server/src/lib/bearer-token.ts::name":
    "`envPort`'s own body — the helper whose callers #768 made visible. It resolves to exactly " +
    "the literals passed at its call sites: KANBAN_FLEET_PORT (resolveConfiguredFleetPort, same " +
    "file) and KANBAN_GIT_HTTP_PORT (git-http.service.ts). Both are checked against " +
    "docs/env-vars.md through ENV_READER_HELPERS, so this dynamic read is the implementation of " +
    "a checked contract rather than a gap in one. Forcing a literal in here would mean one " +
    "hand-copied port parser per variable — the drift #556 removed.",
  "packages/server/src/lib/env-registry.ts::entry.name":
    "`readBoardEnv`'s canonical read. Resolves only to a `KANBAN_ENV` entry's `name` — the " +
    "function throws for a name that is not registered — so the reachable set is the registry " +
    "table: KANBAN_DB_URL, KANBAN_ALLOW_DB_DESTROY, KANBAN_AGENT_COMMAND, KANBAN_MOCK_AGENT, " +
    "KANBAN_STUCK_BUILDER_TIMEOUT_MS, KANBAN_PLUGIN_VIEW_READY_TIMEOUT_MS, " +
    "KANBAN_SLOW_REQUEST_THRESHOLD_MS. #615's parity test pins every one to a doc row.",
  "packages/server/src/lib/env-registry.ts::entry.legacyAlias":
    "the same read for the pre-#615 spelling of each of those seven: DB_URL, ALLOW_DB_DESTROY, " +
    "AGENT_COMMAND, MOCK_AGENT, STUCK_BUILDER_TIMEOUT_MS, PLUGIN_VIEW_READY_TIMEOUT_MS, " +
    "SLOW_REQUEST_THRESHOLD_MS. Honouring a rename REQUIRES reading a name held as data — a " +
    "literal here would defeat the purpose of the alias column.",
  "packages/server/src/scripts/mock-agent.ts::envKey":
    "the mock agent's `getConfig(flag)`, which derives `MOCK_<FLAG>` from a CLI flag name: " +
    "MOCK_SESSION_ID, MOCK_PROFILE, MOCK_DELAY_MS, MOCK_RESUME. Test-harness surface, not the " +
    "product's configuration surface — the mock agent is selected by the `claude_profile` " +
    "preference and these mirror its own flags one-for-one.",
  "packages/server/src/services/agent-profile-health.service.ts::key":
    "iterates PI_API_KEY_ENV_KEYS to answer 'is any Pi credential present?'. Resolves to the " +
    "seven vendor keys in that array (ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY, " +
    "GEMINI_API_KEY, GROQ_API_KEY, MISTRAL_API_KEY, OPENROUTER_API_KEY) — all foreign names " +
    "owned by their vendors, and the question is about the SET, so a literal per key would be " +
    "seven copies of one predicate.",
};

interface Read {
  name: string;
  file: string;
  line: number;
  /** True when the read went through an alias binding rather than a literal `process.env`. */
  viaAlias: boolean;
  /** The env-reader helper this name was passed to, when it was not a direct read (#768). */
  viaHelper?: string;
}

const relToRoot = (file: string): string => path.relative(repoRoot, file).split(path.sep).join("/");

/** `process.env`, through any number of parens/`as`/`!` wrappers. */
function isProcessEnv(expr: ts.Expression): boolean {
  const target = unwrapExpression(expr);
  if (!ts.isPropertyAccessExpression(target) || target.name.text !== "env") return false;
  const base = unwrapExpression(target.expression);
  return ts.isIdentifier(base) && base.text === "process";
}

/**
 * Names bound to `process.env` itself in this file — `const env = process.env`, with or
 * without a `NodeJS.ProcessEnv` annotation. Deliberately only bindings whose INITIALISER is
 * `process.env`: a parameter merely *typed* `NodeJS.ProcessEnv` is usually a spawn env being
 * BUILT (`buildSpawnEnv`), and reading a key off one of those says nothing about this
 * process's own configuration surface.
 */
function envAliases(sf: ts.SourceFile): Set<string> {
  const aliases = new Set<string>();
  forEachNode(sf, (node) => {
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
      ts.isIdentifier(node.name) &&
      (isEnvTypeReference(node.type) || (node.initializer && isProcessEnv(node.initializer)))
    ) {
      aliases.add(node.name.text);
    }
  });
  return aliases;
}

/**
 * `NodeJS.ProcessEnv` as a type annotation. This is the OTHER half of the alias story and it
 * is what `IS_SANDBOX` escaped through: `detectBoardDeployment(root, env: NodeJS.ProcessEnv =
 * process.env, …)` and `defaultContainerized(env: NodeJS.ProcessEnv)` are the injectable-env
 * seam the repo is deliberately moving to, and a read on such a parameter is a read of THIS
 * process's environment at every real call site. The annotation is the discriminator that
 * keeps it away from a spawn env being BUILT: `buildSpawnEnv` and friends hand around
 * `Record<string, string>`, not `NodeJS.ProcessEnv`.
 */
function isEnvTypeReference(type: ts.TypeNode | undefined): boolean {
  if (!type || !ts.isTypeReferenceNode(type)) return false;
  const name = type.typeName;
  if (ts.isQualifiedName(name)) return name.right.text === "ProcessEnv";
  return name.text === "ProcessEnv";
}

/** `process.env[expr]` with a non-literal key — the one shape a name-based rule cannot judge. */
interface DynamicRead {
  file: string;
  line: number;
  /** The key expression as written, e.g. `name` or `entry.legacyAlias`. Stable under line moves. */
  keyExpr: string;
}

interface ScanResult {
  reads: Read[];
  computed: DynamicRead[];
  filesScanned: number;
}

/**
 * Every env read in ONE source. Factored out of the tree walk so #768's proof cases can drive
 * the REAL scanner over a synthetic file — a proof against a re-implementation of the
 * predicate would prove nothing about the predicate that runs.
 */
export function scanEnvReadsInSource(absFile: string, text?: string): { reads: Read[]; computed: DynamicRead[] } {
  const reads: Read[] = [];
  const computed: DynamicRead[] = [];
  const sf = parseGuardSource(absFile, text);
  const aliases = envAliases(sf);
  const rel = relToRoot(absFile);
  /** `process.env` itself, or an identifier bound to it. */
  const envBearing = (expr: ts.Expression): "direct" | "alias" | null => {
    if (isProcessEnv(expr)) return "direct";
    const target = unwrapExpression(expr);
    return ts.isIdentifier(target) && aliases.has(target.text) ? "alias" : null;
  };
  const push = (name: string, node: ts.Node, via: "direct" | "alias", viaHelper?: string): void => {
    reads.push({ name, file: rel, line: lineOf(sf, node), viaAlias: via === "alias", viaHelper });
  };

  forEachNode(sf, (node) => {
    // `envPort("KANBAN_FLEET_PORT", …)` / `readBoardEnv("KANBAN_DB_URL", …)` — the name is a
    // literal in argument position, and the read itself happens inside the helper (#768).
    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression);
      const helper = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null;
      if (helper !== null && helper in ENV_READER_HELPERS) {
        const arg = node.arguments[ENV_READER_HELPERS[helper]!];
        if (arg && ts.isStringLiteralLike(arg)) push(arg.text, arg, "direct", helper);
      }
      return;
    }
    // `process.env.NAME` / `env.NAME`
    if (ts.isPropertyAccessExpression(node)) {
      const via = envBearing(node.expression);
      if (via) push(node.name.text, node, via);
      return;
    }
    // `process.env["NAME"]` / `process.env['NAME']` / `env["NAME"]`
    if (ts.isElementAccessExpression(node)) {
      const via = envBearing(node.expression);
      if (!via) return;
      const arg = node.argumentExpression;
      if (arg && ts.isStringLiteralLike(arg)) push(arg.text, node, via);
      else computed.push({ file: rel, line: lineOf(sf, node), keyExpr: arg ? arg.getText(sf) : "<none>" });
      return;
    }
    // `const { NAME } = process.env`
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      isProcessEnv(node.initializer)
    ) {
      for (const el of node.name.elements) {
        const source = el.propertyName ?? el.name;
        if (ts.isIdentifier(source)) push(source.text, el, "direct");
      }
    }
  });
  return { reads, computed };
}

function scanReads(): ScanResult {
  const reads: Read[] = [];
  const computed: DynamicRead[] = [];
  let filesScanned = 0;

  for (const root of SCAN_ROOTS) {
    for (const file of walkPackageSources(path.join(repoRoot, root), { extensions: SCAN_EXTENSIONS })) {
      filesScanned += 1;
      const found = scanEnvReadsInSource(file);
      reads.push(...found.reads);
      computed.push(...found.computed);
    }
  }
  return { reads, computed, filesScanned };
}

/**
 * The names that have a ROW on the inventory page: a backticked name in the FIRST cell of a
 * markdown table row. #734 — the old check was ``doc.includes("`NAME`")``, which any prose
 * mention satisfied, so the page's own paragraph about undocumented variables could document
 * one. One cell may name a pair (`KANBAN_TLS_CERT`, `KANBAN_TLS_KEY`), which is why every
 * backticked name in the cell counts rather than just the first.
 */
function docRowNames(doc: string): Set<string> {
  const names = new Set<string>();
  for (const line of doc.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const firstCell = trimmed.replace(/^\|/, "").split("|")[0] ?? "";
    for (const m of firstCell.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)) names.add(m[1]!);
  }
  return names;
}

const isBoardOwned = (name: string): boolean => BOARD_PREFIXES.some((p) => name.startsWith(p));

/**
 * The offender set of the doc-row rule, as ONE function, so #768's proof case asserts against
 * the very predicate the tree scan fails on rather than re-deriving it from its parts.
 */
function undocumentedBoardVars(reads: Read[], documented: ReadonlySet<string>): string[] {
  return [...new Set(reads.filter((r) => isBoardOwned(r.name) && !documented.has(r.name)).map((r) => r.name))].sort();
}

describe("every process.env read has a known owner (#707)", () => {
  const { reads, computed, filesScanned } = scanReads();
  const doc = fs.readFileSync(path.join(repoRoot, "docs", "env-vars.md"), "utf8");
  const documented = docRowNames(doc);
  const whereFirst = (name: string): string => {
    const r = reads.find((x) => x.name === name)!;
    return `${r.file}:${r.line}`;
  };

  it("finds env reads at all — a rule over an empty set guards nothing", () => {
    expect(filesScanned).toBeGreaterThan(500);
    expect(reads.length).toBeGreaterThan(30);
  });

  it("sees reads through an alias binding, which is where the code is heading (#734)", () => {
    // The property the regex predicate lacked: `const env = process.env; env.NAME`. If this
    // ever finds nothing, the alias tracking has silently stopped working and the guard has
    // narrowed back to the reach #734 widened it from — without any assertion going red.
    expect(reads.filter((r) => r.viaAlias).length).toBeGreaterThan(10);
  });

  it("the inventory page has real rows to check against", () => {
    // `docRowNames` is the stricter half of #734. If the row parser broke, every board var
    // would look undocumented and the failure would read as a documentation problem rather
    // than as a broken guard.
    expect(documented.size).toBeGreaterThan(40);
  });

  it("every board-owned variable has a row in docs/env-vars.md", () => {
    const undocumented = undocumentedBoardVars(reads, documented);

    expect(
      undocumented,
      [
        "These are board-owned by the naming rule but have no ROW on the page that claims to",
        "be the inventory. Add one — the purpose, and the default if it has one. A mention in",
        "prose is not a row (#734).",
        "",
        ...undocumented.map((n) => `  ${n}  (${whereFirst(n)})`),
      ].join("\n"),
    ).toEqual([]);
  });

  it("every foreign variable is declared with whose it is", () => {
    const undeclared = [...new Set(reads.filter((r) => !isBoardOwned(r.name) && !(r.name in FOREIGN)).map((r) => r.name))].sort();

    expect(
      undeclared,
      [
        "An unprefixed `process.env` read whose owner nobody has stated. Either:",
        "  - it is ours -> rename it `KANBAN_<NAME>` and give it a row in docs/env-vars.md,",
        "  - or it is not -> add it to FOREIGN with a note on whose it is.",
        "The point is that an unprefixed name in an agent's spawn env is ambiguous about",
        "ownership, which is exactly what #615 set out to fix and #707 finishes.",
        "",
        ...undeclared.map((n) => `  ${n}  (${whereFirst(n)})`),
      ].join("\n"),
    ).toEqual([]);
  });

  it("has no stale FOREIGN entry — a dead exemption excuses the next name that lands on it", () => {
    const live = new Set(reads.map((r) => r.name));
    const stale = Object.keys(FOREIGN)
      .filter((n) => !live.has(n))
      .sort();
    expect(
      stale,
      `FOREIGN declares variables the tree no longer reads — delete them:\n  ${stale.join("\n  ")}`,
    ).toEqual([]);
  });

  it("no FOREIGN entry claims a board-prefixed name", () => {
    // `KANBAN_FOO` in FOREIGN would exempt one of our own variables from documentation,
    // which is the one way this guard could be turned against its own purpose.
    expect(Object.keys(FOREIGN).filter(isBoardOwned)).toEqual([]);
  });

  it("every DYNAMIC_ENV_READS note actually names the variables it can resolve to", () => {
    // Same rule as FOREIGN's note check, and the same reason (#734): an exemption whose reason
    // is a placeholder is a bypass with a comment on it.
    const thin = Object.entries(DYNAMIC_ENV_READS)
      .filter(([, why]) => why.trim().length < 40)
      .map(([site]) => site);
    expect(thin, "a DYNAMIC_ENV_READS note must say WHICH names the site can resolve to").toEqual([]);
  });

  it("every FOREIGN note actually says something about ownership", () => {
    const empty = Object.entries(FOREIGN)
      .filter(([, why]) => why.trim().length < 10)
      .map(([n]) => n);
    expect(empty, "a FOREIGN note must name the owner, not just exist").toEqual([]);
  });

  /**
   * `process.env[someExpression]` reads a variable whose NAME is not in the source, so no
   * name-based rule can judge the read ITSELF. Each such site is now named and reasoned
   * (#768) rather than counted: a count answered "how many reads can we not see?" and never
   * "which variable was that?", which is how two board-prefixed vars slipped past.
   */
  it("every dynamically-keyed env read is a declared site with its resolvable names", () => {
    const seen = new Map<string, DynamicRead>();
    for (const c of computed) seen.set(`${c.file}::${c.keyExpr}`, c);

    const undeclared = [...seen.keys()].filter((k) => !(k in DYNAMIC_ENV_READS)).sort();
    expect(
      undeclared,
      [
        "A NEW dynamically-keyed env read. `process.env[<expr>]` hides the variable's name from",
        "every ownership rule here, so it needs an entry in DYNAMIC_ENV_READS saying which names",
        "it can resolve to and why the indirection belongs at that site. If the names are literals",
        "at the CALL sites, the cheaper fix is to add the function to ENV_READER_HELPERS instead —",
        "then the literals are checked against docs/env-vars.md like any direct read.",
        "",
        ...undeclared.map((k) => `  ${k}  (${seen.get(k)!.file}:${seen.get(k)!.line})`),
      ].join("\n"),
    ).toEqual([]);

    const stale = Object.keys(DYNAMIC_ENV_READS)
      .filter((k) => !seen.has(k))
      .sort();
    expect(
      stale,
      [
        "DYNAMIC_ENV_READS declares sites that no longer exist — delete them. A dead entry",
        "excuses the next dynamic read that lands on the same file and key expression:",
        "",
        ...stale,
      ].join("\n"),
    ).toEqual([]);
  });

  it("resolves a name passed to an env-reader HELPER — the #768 hole", () => {
    // Non-vacuity for ENV_READER_HELPERS, pinned on the two variables that proved the hole.
    const viaHelper = reads.filter((r) => r.viaHelper !== undefined).map((r) => r.name);
    expect(viaHelper).toContain("KANBAN_FLEET_PORT");
    expect(viaHelper).toContain("KANBAN_GIT_HTTP_PORT");
    // …and they are board-owned, so the doc-row assertion above is what actually holds them.
    expect(documented.has("KANBAN_FLEET_PORT")).toBe(true);
    expect(documented.has("KANBAN_GIT_HTTP_PORT")).toBe(true);
  });
});

/**
 * #768's proof obligation: a new helper-passed board variable with no doc row must make the
 * guard go red. Driven through the REAL {@link scanEnvReadsInSource}, over a synthetic source,
 * so the check is on the predicate that runs in the tree scan above.
 */
describe("a helper-passed name with no doc row fails the guard (#768)", () => {
  const doc = fs.readFileSync(path.join(repoRoot, "docs", "env-vars.md"), "utf8");
  const documented = docRowNames(doc);

  const scan = (name: string, lines: string[]): ReturnType<typeof scanEnvReadsInSource> =>
    scanEnvReadsInSource(path.join(repoRoot, "packages", "server", "src", `virtual-${name}.ts`), lines.join("\n"));

  it("sees `envPort(\"KANBAN_SOMETHING_NEW\", …)` as a named board-owned read", () => {
    const { reads, computed } = scan("new-port", [
      "export function listenPort(): number | null {",
      '  return envPort("KANBAN_SOMETHING_NEW", {',
      "    fallback: null,",
      '    logPrefix: "[x]",',
      '    onInvalid: "disabled",',
      "  });",
      "}",
    ]);
    expect(reads.map((r) => r.name)).toEqual(["KANBAN_SOMETHING_NEW"]);
    expect(reads[0]!.viaHelper).toBe("envPort");
    // The doc-row rule's OWN offender function is what must report it — this is the "goes red"
    // half. Before #768 this read produced NOTHING at all: not even a computed entry, since the
    // name never touched `process.env` in this file.
    expect(undocumentedBoardVars(reads, documented)).toEqual(["KANBAN_SOMETHING_NEW"]);
    expect(computed).toEqual([]);
  });

  it("still resolves the same name written the long way, so the two agree", () => {
    const { reads } = scan("long-way", ['const raw = process.env["KANBAN_SOMETHING_NEW"];', "export default raw;"]);
    expect(reads.map((r) => r.name)).toEqual(["KANBAN_SOMETHING_NEW"]);
    expect(reads[0]!.viaHelper).toBeUndefined();
  });

  it("a NEW dynamically-keyed read is undeclared, not silently under a cap", () => {
    const { computed } = scan("dynamic", [
      "export function pick(env: NodeJS.ProcessEnv, which: string) {",
      "  return env[which];",
      "}",
    ]);
    expect(computed.map((c) => c.keyExpr)).toEqual(["which"]);
    const key = `${computed[0]!.file}::${computed[0]!.keyExpr}`;
    expect(key in DYNAMIC_ENV_READS).toBe(false);
  });
});
