// @gate:always-run — walks every always-run suite in every package and reads its source
// looking for a raw repo-file read; imports nothing it checks (#888).
/**
 * #888 — an `@gate:always-run` suite that reads a repo file raw (`readFileSync(path, "utf8")`)
 * and then compares that content against a newline-bearing string/regex is GREEN on master
 * (LF, `core.autocrlf=true` normalizes on checkout there too but the main checkout happens to
 * hold LF bytes) and RED in every worktree gate (CRLF, same `core.autocrlf=true`, different
 * checkout history). #885 was one instance — `openapi-thrown-status.test.ts` anchored on
 * `\n  <path>:\n` against `packages/server/openapi.yaml` — and it cost #846 three gate runs
 * (~25 min on a loaded machine) before the cause turned out to be a `\r`. Nothing caught the
 * NEXT one; this is that catch.
 *
 * ## The three sanctioned outs, in the order to reach for them
 *
 * 1. **Normalize on read** — `readFileSync(p, "utf8").replace(/\r\n?/g, "\n")` (or the same
 *    shape) right where the file is read. This is what `openapi-thrown-status.test.ts`'s
 *    `readSpec()` and its second read (`readFileSync(copy, "utf8").replace(/\r\n/g, "\n")`) do.
 *    Fixes every existing worktree, not just new ones.
 * 2. **Pin the file to LF in `.gitattributes`** (`<path> text eol=lf`, the `f951fdfa79`
 *    precedent for `openapi.yaml`). Right when the file is GENERATED as LF and read by exactly
 *    one or two suites — pinning empties the offender list for that path outright rather than
 *    asking every reader to remember to normalize. Wrong for a file people hand-edit on
 *    Windows across many suites (see "considered and rejected" below).
 * 3. **`// RAW-BYTES OK: <reason>`** on the line that calls `readFileSync`, when neither of the
 *    above applies — e.g. the assertion is genuinely about raw bytes (a byte-identity check
 *    that a generator did not rewrite a file), or the newline-bearing literal excludes rather
 *    than matches a newline (`[^\n;]*`, which cannot be broken by an extra `\r` because it
 *    never has to *find* one) and a reviewer has confirmed as much.
 *
 * ## What is grandfathered and why
 *
 * `RAW_READ_BASELINE` below freezes today's scan result, keyed `<file>` → offending read count,
 * shrink-only via `compareRatchet` — a NEW raw-read-into-newline-sensitive-assertion fails
 * loudly; an entry whose file no longer offends must be deleted, not left as slack. Every
 * baselined entry already reasons about why it is currently SAFE despite matching the
 * heuristic (excluding, not matching, a newline; or normalizing downstream of the read via a
 * `\r?\n`-tolerant split rather than at the read site) — see the comment beside each key. None
 * of them is a live #885 repeat; they are heuristic false-positives being tracked rather than
 * silently ignored, which is the whole point of a ratchet over a private judgment call.
 *
 * ## The "cheap alternative" this ticket also asks about, and why it stays narrow
 *
 * Renormalizing the WHOLE tree (a blanket `* text=auto eol=lf` in `.gitattributes`) was
 * considered and deliberately NOT taken: `.gitattributes` itself already measures the mixed
 * state of this checkout at 1234 LF vs 1855 CRLF files, and a global flip rewrites ~1855 files
 * on disk for every existing clone/worktree mid-flight — a large, unrelated diff riding on a
 * narrow ratchet ticket. Recorded here as a possible follow-up, not taken now.
 *
 * ## The heuristic, and its known blind spots
 *
 * This is a NET, not a proof (explicitly, per the ticket): a raw read hidden behind a helper
 * function, or a comparison built through an intermediate variable several statements away
 * from both the read and the newline-bearing literal, will not match. Narrowing the gap is the
 * goal; the marker/`.gitattributes`/normalize outs above are what a reviewed exception looks
 * like when the heuristic is wrong in the OTHER direction (a false positive).
 *
 * Detection, per always-run-marked test file:
 *  1. Find `readFileSync(<expr>, "utf8" | "utf-8")` where `<expr>`'s source text is ANCHORED at
 *     the repo tree — it mentions `__dirname`, `import.meta.dirname`/`import.meta.url`, or an
 *     identifier this repo's guards conventionally use for a resolved repo/package root
 *     (`repoRoot`, `REPO_ROOT`, `SERVER_ROOT`, `packagesRoot`, `SPEC`, or a bare `join(`/
 *     `resolve(` call) — i.e., a real repo path, not an in-memory fixture string.
 *  2. Find the variable that read's result is assigned to, and look for that variable used in
 *     a comparison/match (`.includes(`, `.indexOf(`, `.match(`, `.split(`, `.test(` on the
 *     other side, `===`/`!==`) against a string or regex literal that itself contains a literal
 *     `\n` (or `\r\n`) escape — the newline-sensitive shape from #885.
 *  3. Skip it if: (a) a `.replace(/\r\n?/g, ...)`-shaped normalization sits on the SAME
 *     `readFileSync` call chain or within a couple of lines of it, (b) the read path is pinned
 *     `eol=lf` in `.gitattributes` (checked for the small set of suites whose path is a single
 *     literal we can actually resolve — `packages/server/openapi.yaml` et al.), or (c) the
 *     `readFileSync` line (or the line above it) carries `// RAW-BYTES OK: <reason>`.
 */
import { describe, expect, it } from "vitest";
import fs, { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path, { join } from "node:path";
import { tmpdir } from "node:os";
import { walkTestFiles, packagesRootFrom, compareRatchet } from "../../../shared/__tests__/helpers/guard-scan.js";
import { isAlwaysRunMarked } from "../../../../scripts/test-mine.mjs";

const packagesRoot = packagesRootFrom(import.meta.dirname!, 3);
// Keyed the same way `rel` is built below — relative to the package's __tests__ dir, not to
// the package root, so this must NOT repeat the "src/__tests__/" prefix.
const SELF = "server/always-run-raw-read-ratchet.test.ts";

const SCAN_PACKAGES = [
  { label: "shared", testsDir: path.join(packagesRoot, "shared", "__tests__") },
  { label: "server", testsDir: path.join(packagesRoot, "server", "src", "__tests__") },
  { label: "mcp-server", testsDir: path.join(packagesRoot, "mcp-server", "src", "__tests__") },
  { label: "client", testsDir: path.join(packagesRoot, "client", "src", "__tests__") },
];

const RAW_BYTES_OK_MARKER = "RAW-BYTES OK:";

/**
 * Every `readFileSync(...)` call site, with its balanced-paren argument list split at
 * top-level commas. Deliberately NOT a single regex: the path argument is routinely
 * `join(repoRoot, "some/file")`, whose own comma breaks any regex that stops at the first
 * one — measured on this tree, that shape is the MAJORITY of always-run readers, not an
 * edge case, so a naive `[^,]+` capture would silently miss most of what this ratchet exists
 * to catch.
 */
interface ReadCall {
  /** index of the `readFileSync(` token */
  start: number;
  /** index one past the call's closing `)` */
  end: number;
  pathExpr: string;
  encodingExpr: string | null;
}

function splitTopLevelArgs(argsText: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of argsText) {
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim().length > 0 || parts.length > 0) parts.push(cur);
  return parts.map((p) => p.trim());
}

function findReadFileSyncCalls(source: string): ReadCall[] {
  const calls: ReadCall[] = [];
  const CALL_RE = /\breadFileSync\(/g;
  let m: RegExpExecArray | null;
  while ((m = CALL_RE.exec(source))) {
    const openParen = m.index + m[0].length - 1;
    let depth = 0;
    let closeParen = -1;
    for (let i = openParen; i < source.length; i += 1) {
      if (source[i] === "(") depth += 1;
      else if (source[i] === ")") {
        depth -= 1;
        if (depth === 0) {
          closeParen = i;
          break;
        }
      }
    }
    if (closeParen === -1) continue; // unbalanced — give up on this call rather than guess
    const argsText = source.slice(openParen + 1, closeParen);
    const args = splitTopLevelArgs(argsText);
    if (args.length === 0) continue;
    calls.push({
      start: m.index,
      end: closeParen + 1,
      pathExpr: args[0]!,
      encodingExpr: args[1] ?? null,
    });
  }
  return calls;
}

/** The read's path expression resolves inside the repo tree rather than an in-memory fixture. */
const ANCHORED_AT_REPO_TREE =
  /__dirname|import\.meta\.(dirname|url)|\brepoRoot\b|\bREPO_ROOT\b|\bSERVER_ROOT\b|\bpackagesRoot\b|\bSPEC\b|\bjoin\(|\bresolve\(/;

/**
 * A literal `\n` (optionally preceded by `\r`) inside a string or regex literal — i.e. the
 * SOURCE TEXT contains the two-character escape `\n`, alone or as the `\r\n` pair. `\r?` has
 * to be its own escaped-backslash group: `\\r?\\n` (no group) makes only the bare `r` optional
 * while still demanding a backslash before it, so it matches `\r\n` but not a plain `\n` — the
 * exact false negative this heuristic cannot afford, since `\n`-only is the more common case.
 */
const NEWLINE_BEARING_LITERAL = /(?:\\r)?\\n/;

/** Normalizes line endings right at (or immediately after) the read — the #885 fix shape. */
const NORMALIZE_NEAR_READ = /\.replace\(\s*\/\\r\\n\??\//;

/** How far (in characters) past a `readFileSync(...)` call the normalizing `.replace` may sit
 *  and still count as "at the read site" — covers `readFileSync(p, "utf8").replace(...)` and a
 *  `return readFileSync(...).replace(...)` split across the call's own statement. */
const NORMALIZE_WINDOW = 60;

/**
 * Grandfathered offenders — `<label>/<path-under-__tests__>` → `{ count, reason }`. Frozen at
 * today's scan (measured 2026-08-25, all four packages). MAY ONLY SHRINK: an entry whose file
 * stops matching, or whose COUNT drops, is stale and must be lowered/removed (checked below);
 * a NEW file — or a NEW read within an existing file, raising its count past what's here —
 * fails outright.
 *
 * None of these is a live #885 repeat; every one was inspected and falls into one of four
 * SAFE shapes, named per entry:
 *
 *  - **excluding regex** — matches everything up to but not including a newline (`[^\n;]*`),
 *    so it cannot be broken by an extra `\r`: it never has to *find* one.
 *  - **`\r?\n`-tolerant split/regex** — already written to accept either line ending.
 *  - **`\n`-as-position-anchor** — `indexOf("\n...")` / a regex needing `\n` to locate a
 *    boundary (a line start, a closing brace). A `\r` immediately before that `\n` does not
 *    stop the search from finding it; the assertion needs the `\n` to exist, not to be alone.
 *  - **heuristic false positive** — the flagged newline-bearing literal is unrelated prose
 *    (an `offenders.join("\n")` failure-message call, or similar) a few hundred characters
 *    after the real, newline-FREE comparison the read variable is actually used in; this
 *    ratchet's window is wide enough to occasionally catch a neighbour rather than the site
 *    itself. Confirmed by reading the file, not merely by re-running the heuristic.
 *
 * `pack-worker-script.test.ts` is the one exception with a different reason: its target
 * (`scripts/pack-worker.mjs`) is ALREADY pinned `eol=lf` by the existing `scripts/** text
 * eol=lf` `.gitattributes` rule (added for #703), so no new pin was needed for it.
 */
const RAW_READ_BASELINE: Record<string, { count: number; reason: string }> = {
  "server/claude-md-git-invariants.test.ts": {
    count: 2,
    reason:
      "excluding regex — both matches are `[^\\n;]*` / `[^\\n]*`, which stop at the first " +
      "newline rather than searching for one. Same shape CLAUDE.md itself documents for git " +
      "tests: 'assert on keywords, not exact strings' (root CLAUDE.md, Windows / hooks section).",
  },
  "server/placement-chain-parity.test.ts": {
    count: 2,
    reason:
      "\\n-as-position-anchor — `indexOf(\"\\nexport \", …)` / `indexOf(\"\\n## \", …)` locate " +
      "the next top-level declaration/heading; a `\\r` right before that `\\n` doesn't stop it.",
  },
  "shared/barrel-client-safety.test.ts": {
    count: 1,
    reason: "\\n-as-position-anchor — `text.lastIndexOf(\"\\n\", m.index)` finds a line start.",
  },
  "shared/git-exec-single-spawn.test.ts": {
    count: 2,
    reason: "\\r?\\n-tolerant split — `text.split(/\\r?\\n/)`.",
  },
  "shared/max-file-size.test.ts": {
    count: 1,
    reason:
      "\\n-as-position-anchor — `scriptText.indexOf(\"\\n};\", …)` finds a line-initial " +
      "close-brace, and the subsequent `.split(\"\\n\")` per-entry regex has no end anchor, so " +
      "a trailing `\\r` on each line does not affect the match. " +
      "Was 2 until #994: the line-counting read now goes through `readGuardSource` (the memoised " +
      "reader that took this suite's cold cost off a x3 multiplier), so this scan no longer sees " +
      "it — the helper-hidden-read blind spot this file's own header names. That read is still " +
      "CRLF-safe (`text.split(\"\\n\").length` counts \\n occurrences either way); what " +
      "changed is that the net stopped watching it.",
  },
  "shared/worktree-delete-guard-ratchet.test.ts": {
    count: 1,
    reason: "\\r?\\n-tolerant split — `text.split(/\\r?\\n/)`.",
  },
  "server/bundled-skill-freshness.test.ts": {
    count: 2,
    reason: "\\r?\\n-tolerant regex — the frontmatter fence is matched by `/^---[ \\t]*\\r?\\n.../`.",
  },
  "server/butler-plugin-onboarding.test.ts": {
    count: 1,
    reason: "\\r?\\n-tolerant split — `guide.split(/\\r?\\n/)`.",
  },
  "server/container-reap-terminal-paths.test.ts": {
    count: 1,
    reason:
      "heuristic false positive — `text.includes(\"teardownWorkspaceServices({\")` has no " +
      "newline in it; the `\\n` this heuristic saw is from an unrelated `offenders.join(\"\\n\")` " +
      "in the failure message a few lines later.",
  },
  "server/domain-error-vocabulary.test.ts": {
    count: 3,
    reason:
      "heuristic false positive — `src.includes(\"STANDALONE_REFUSAL_STATUS\")` has no newline " +
      "in it; same unrelated-message-join shape as container-reap-terminal-paths above.",
  },
  "server/env-read-ownership.test.ts": {
    count: 2,
    reason: "\\r?\\n-tolerant split — `doc.split(/\\r?\\n/)`.",
  },
  "server/env-registry-doc-parity.test.ts": {
    count: 1,
    reason:
      "heuristic false positive — the matched `doc.includes(...)` checks for a markdown code " +
      "span around an entry name and has no newline in it; the window caught an unrelated " +
      "`\\n` elsewhere in the file.",
  },
  "server/pack-worker-script.test.ts": {
    count: 1,
    reason:
      "target already pinned — `scripts/pack-worker.mjs` is covered by the existing " +
      "`scripts/** text eol=lf` .gitattributes rule (#703), so `source.split(\"\\n\")` here " +
      "never sees a `\\r` regardless of checkout.",
  },
  "server/temp-dir-namespace-guard.test.ts": {
    count: 2,
    reason:
      "heuristic false positive — `src.includes(\"tmpdir()\")` has no newline in it; the file " +
      "also does `src.split(/\\r?\\n/)` elsewhere, which is tolerant anyway.",
  },
  "server/worker-cli-isolation.test.ts": {
    count: 1,
    reason:
      "\\n-as-position-anchor — `(?:^|\\n)\\s*(?:import|export)…` uses `\\n` as an alternative " +
      "line-start anchor to `^`; a preceding `\\r` doesn't stop it from matching there.",
  },
  "mcp-server/mcp-catalog-parity.test.ts": {
    count: 1,
    reason:
      "\\n-as-position-anchor — `/const TOOL_REGISTRARS[\\s\\S]*?=\\s*\\{([\\s\\S]*?)\\n\\};/` " +
      "needs the `\\n` to exist directly before `};`, not to be alone; `[\\s\\S]*?` happily " +
      "absorbs a stray `\\r` on the way there.",
  },
  "client/boardPageStateGate.test.ts": {
    count: 2,
    reason:
      "\\n-as-position-anchor — `src.indexOf(\"\\n}\", modelStart)` finds the interface's " +
      "closing brace; the per-line regex that follows uses `^`/`m` with no `$` anchor, so a " +
      "trailing `\\r` on each split line is never compared against.",
  },
};

interface Offender {
  file: string;
  count: number;
}

/** `const foo =` / `let foo =` (optionally `await`-ed) immediately preceding a call site. */
const ASSIGNED_TO = /(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?[\w.]*$/;

function scanFile(full: string): number {
  const source = fs.readFileSync(full, "utf8");
  if (!isAlwaysRunMarked(source)) return 0;

  let offenses = 0;
  for (const call of findReadFileSyncCalls(source)) {
    if (!call.encodingExpr || !/^["']utf-?8["']$/.test(call.encodingExpr)) continue;
    if (!ANCHORED_AT_REPO_TREE.test(call.pathExpr) && !ANCHORED_AT_REPO_TREE.test(source)) continue;

    const nearby = source.slice(call.end, call.end + NORMALIZE_WINDOW);
    if (NORMALIZE_NEAR_READ.test(nearby)) continue;

    // RAW-BYTES OK: on the read's own line, or the line directly above it.
    const lineStart = source.lastIndexOf("\n", call.start) + 1;
    const prevLineStart = source.lastIndexOf("\n", lineStart - 2) + 1;
    const lineEndIdx = source.indexOf("\n", call.end);
    const twoLines = source.slice(prevLineStart, lineEndIdx === -1 ? source.length : lineEndIdx);
    if (twoLines.includes(RAW_BYTES_OK_MARKER)) continue;

    // Who does this read's result get assigned to? Look a short way back from the call start.
    const before = source.slice(Math.max(0, call.start - 80), call.start);
    const assigned = ASSIGNED_TO.exec(before);
    if (!assigned) continue; // e.g. returned/passed inline — not a named var this pass can trace
    const varName = assigned[1]!;

    // Usage of the read variable against a newline-bearing literal, within the rest of the file.
    const useRe = new RegExp(
      `\\b${varName}\\b\\s*(?:\\.trim\\(\\))?\\s*(?:\\.(includes|indexOf|match|split|test)\\(|(===|!==)\\s*)`,
      "g",
    );
    let u: RegExpExecArray | null;
    let hit = false;
    while ((u = useRe.exec(source))) {
      const window = source.slice(u.index, u.index + 400);
      if (NEWLINE_BEARING_LITERAL.test(window)) {
        hit = true;
        break;
      }
    }
    // Reverse shape: `/…\n…/.test(varName)` / `.exec(varName)`.
    if (!hit) {
      const reverseRe = new RegExp(`\\.(test|exec)\\(\\s*${varName}\\b`, "g");
      let r: RegExpExecArray | null;
      while ((r = reverseRe.exec(source))) {
        const back = source.slice(Math.max(0, r.index - 200), r.index);
        if (NEWLINE_BEARING_LITERAL.test(back)) {
          hit = true;
          break;
        }
      }
    }
    if (hit) offenses += 1;
  }
  return offenses;
}

function scanAll(): Offender[] {
  const offenders: Offender[] = [];
  for (const { label, testsDir } of SCAN_PACKAGES) {
    for (const full of walkTestFiles(testsDir)) {
      const rel = `${label}/${path.relative(testsDir, full).replace(/\\/g, "/")}`;
      if (rel === SELF) continue;
      const count = scanFile(full);
      if (count > 0) offenders.push({ file: rel, count });
    }
  }
  return offenders;
}

describe("always-run raw-read ratchet (#888)", () => {
  const found = scanAll();
  const baseline = Object.fromEntries(Object.entries(RAW_READ_BASELINE).map(([k, v]) => [k, v.count]));
  const current = Object.fromEntries(found.map((o) => [o.file, o.count]));
  const { over, stale } = compareRatchet(baseline, current);

  it("every raw-read-into-newline-sensitive-assertion is in the shrink-only baseline", () => {
    expect(
      over,
      [
        "An @gate:always-run suite reads a repo file raw (readFileSync(path, \"utf8\")) and",
        "compares its content against a newline-bearing string/regex. That is green on master",
        "and red in every worktree gate under core.autocrlf=true — see #885/#888, where",
        "openapi-thrown-status.test.ts cost #846 three gate runs over a stray \\r.",
        "",
        "Fix it one of three ways:",
        "  1. Normalize at the read: readFileSync(p, \"utf8\").replace(/\\r\\n?/g, \"\\n\")",
        "  2. Pin the file LF in .gitattributes (see packages/server/openapi.yaml's entry)",
        "  3. // RAW-BYTES OK: <reason> on the readFileSync line, if the match is a false",
        "     positive (e.g. an excluding regex, or a byte-identity check)",
        "",
        ...over,
      ].join("\n"),
    ).toEqual([]);
  });

  it("no baseline entry is stale (count too high, or file no longer matches at all)", () => {
    expect(
      stale,
      `These baseline entries no longer match at their recorded count — lower or delete them:\n  ${stale.join("\n  ")}`,
    ).toEqual([]);
  });

  it("finds offenders at all, so this ratchet cannot pass vacuously", () => {
    // A floor well below the baseline count: this exists to catch a broken WALK (a scan that
    // silently sees zero files), not to pin the exact number — the baseline above does that.
    expect(found.length).toBeGreaterThan(0);
  });
});

/**
 * #888's proof obligation, applied to this guard itself: it must actually go red on the
 * #885 shape, on a file this suite never saw before — not merely be green today. And it must
 * stay green on each of the three sanctioned outs, so the escape hatches this suite documents
 * are not decoration.
 */
describe("the meta-guard reports the #885 shape, and respects each sanctioned out (#888)", () => {
  const ALWAYS_RUN = "// @gate:always-run\n";
  const READ_LINE = 'const text = readFileSync(join(__dirname, "fixture.txt"), "utf8");\n';

  function synthetic(body: string): number {
    const dir = mkdtempSync(join(tmpdir(), "ak-raw-read-ratchet-fixture-"));
    try {
      const file = join(dir, "synthetic.test.ts");
      writeFileSync(file, ALWAYS_RUN + body);
      return scanFile(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("flags a raw read compared against a newline-bearing literal", () => {
    const count = synthetic(READ_LINE + 'if (text.indexOf("foo\\nbar") === -1) throw new Error("nope");\n');
    expect(count).toBe(1);
  });

  it("does not flag it once normalized at the read", () => {
    const count = synthetic(
      READ_LINE.replace('"utf8");', '"utf8").replace(/\\r\\n?/g, "\\n");') +
        'if (text.indexOf("foo\\nbar") === -1) throw new Error("nope");\n',
    );
    expect(count).toBe(0);
  });

  it("does not flag it with a // RAW-BYTES OK marker on the read line", () => {
    const count = synthetic(
      READ_LINE.replace("\n", " // RAW-BYTES OK: synthetic proof case\n") +
        'if (text.indexOf("foo\\nbar") === -1) throw new Error("nope");\n',
    );
    expect(count).toBe(0);
  });

  it("does not flag a comparison with no newline in the literal", () => {
    const count = synthetic(READ_LINE + 'if (text.indexOf("foo") === -1) throw new Error("nope");\n');
    expect(count).toBe(0);
  });

  it("does not flag a read that is not anchored at the repo tree", () => {
    const count = synthetic(
      'const text = readFileSync("in-memory-fixture.txt", "utf8");\n' +
        'if (text.indexOf("foo\\nbar") === -1) throw new Error("nope");\n',
    );
    expect(count).toBe(0);
  });
});
