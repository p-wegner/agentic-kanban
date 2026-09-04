// guard-inventory — an INVENTORY of the standing guard set (#1022).
//
// ## Why
//
// Every merge runs the whole `@gate:always-run` set plus every `*ratchet*.test.ts`. That set
// only ever grows (169 marked suites and 38 ratchets at the time of writing), and each one is a
// standing tax on every merge on the board. The proposal
// `docs/proposals/2026-09-03-dev-board-vs-deployed-board.md` §3.E asks for the obvious audit:
// merge what checks the same property, drop what has never been red since it was introduced.
//
// This script is the INVENTORY half only. It removes nothing and it recommends nothing beyond a
// candidates list; the decision is a separate pass by the team with the report in hand.
//
// ## Output
//
//   docs/tests/guard-inventory.md    the report (committed)
//   docs/tests/guard-inventory.json  the same data, machine-readable (committed)
//
// Regenerate with `pnpm guard:inventory`.
//
// ## Where each column comes from — and what is honestly missing
//
// - **file / package**: the always-run set is taken from `scripts/test-mine.mjs`'s own
//   `scanAlwaysRunTests` + `ALWAYS_RUN_TESTS_DIR`, IMPORTED rather than re-implemented, so this
//   report cannot claim a different set than the gate actually forces (#538's whole point).
//   Ratchets are a separate name-based sweep (`*ratchet*.test.ts`) over the same package trees.
// - **property**: the first line of the file's leading `/** … */` block, else the rationale
//   trailing the `@gate:always-run` marker, else the first `describe()` title, else `MISSING`.
//   Each row records which of those it used, because a property read off a describe title is a
//   much weaker claim than one written down deliberately.
// - **introduced**: `git log --diff-filter=A --follow`, i.e. the commit that ADDED the file,
//   following renames.
// - **last red on master**: THERE IS NO GATE-OUTCOME LEDGER IN THIS REPO. Neither the DB schema
//   nor `docs/tests/` records "this suite was red on master on date X" — the only base-health
//   signal is the transient `degenerate_base_health` monitor event, which is not persisted per
//   suite. So this column is a PROXY: the most recent commit whose subject/body both names the
//   file and reads like a fix (fix/red/green/broke/failing/re-baseline/unbreak/repair). Every
//   row says `proxy` so nobody reads it as a measurement. A row with no such commit is a
//   *candidate* for "never red since introduction" — not proof of it.
// - **wall time**: read from `docs/tests/durations.json`, the committed output of
//   `pnpm test:durations`. Deliberately NOT measured here: running the guard set to time it is
//   the expensive thing this inventory exists to reduce. Rows absent from that file are blank
//   and are listed as unmeasured rather than assumed fast.
//
// ## Flags
//
//   --json          print the JSON to stdout, write nothing
//   --no-git        skip the two git passes (introduced / last-red proxy) — fast, for tests
//   --out <dir>     output directory (default docs/tests)

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PACKAGES, ALWAYS_RUN_TESTS_DIR, ALWAYS_RUN_TEST_FILE, scanAlwaysRunTests } from "./test-mine.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, "..");

/** Ratchet suites are identified by NAME, the convention this repo already uses. */
const RATCHET_NAME_RE = /ratchet/i;

/** A commit message that reads like somebody repairing a red suite. */
const FIX_ISH_RE = /\b(fix|fixes|fixed|red|green|broke|broken|breaks|breaking|failing|failed|unbreak|repair|rebaseline|re-baseline|baseline|regression|revert)\b/i;

const toPosix = (p) => p.split("\\").join("/");

/* ------------------------------------------------------------------ collection */

/**
 * Every test file under a package's test dir, relative to the package dir.
 * Same walk shape as `scanAlwaysRunTests`, but name-based rather than marker-based — used for
 * the ratchet sweep, which is not a marker property.
 */
function walkTestFiles(pkgDir, testsDir, listDir, found = [], relDir = testsDir) {
  for (const entry of listDir(resolve(pkgDir, relDir))) {
    const name = typeof entry === "string" ? entry : entry.name;
    const isDir = typeof entry === "string" ? false : entry.isDirectory();
    const rel = `${relDir}/${name}`;
    if (isDir) {
      if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
      walkTestFiles(pkgDir, testsDir, listDir, found, rel);
      continue;
    }
    if (ALWAYS_RUN_TEST_FILE.test(name)) found.push(rel);
  }
  return found;
}

/**
 * The guard set: one entry per file, with the kinds it belongs to.
 *
 * A file can be BOTH (most ratchets carry the marker); it still appears exactly once, which is
 * the acceptance criterion of #1022.
 */
export function collectGuardFiles(root = ROOT) {
  const listDir = (d) => (existsSync(d) ? readdirSync(d, { withFileTypes: true }) : []);
  /** @type {Map<string, {path: string, pkg: string, alwaysRun: boolean, ratchet: boolean}>} */
  const byPath = new Map();

  for (const pkg of PACKAGES) {
    const testsDir = ALWAYS_RUN_TESTS_DIR[pkg.label];
    if (!testsDir) {
      throw new Error(
        `[guard:inventory] ALWAYS_RUN_TESTS_DIR has no entry for package "${pkg.label}" — ` +
          `its guard suites would be silently missing from the inventory. Add one.`,
      );
    }
    const pkgDir = resolve(root, pkg.dir);
    if (!existsSync(pkgDir)) continue;

    const upsert = (rel, patch) => {
      const path = toPosix(`${pkg.dir}/${rel}`);
      const cur = byPath.get(path) ?? { path, pkg: pkg.label, alwaysRun: false, ratchet: false };
      byPath.set(path, { ...cur, ...patch });
    };

    for (const rel of scanAlwaysRunTests(pkgDir, testsDir, listDir)) upsert(rel, { alwaysRun: true });
    for (const rel of walkTestFiles(pkgDir, testsDir, listDir)) {
      if (RATCHET_NAME_RE.test(rel.split("/").pop() ?? "")) upsert(rel, { ratchet: true });
    }
  }

  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/* ------------------------------------------------------------------ property */

const PROPERTY_MAX = 200;

/** Strip the comment furniture off one line of a `/** … *\/` block. */
const stripStar = (line) => line.replace(/^\s*\*\s?/, "").trimEnd();

/**
 * The one-line property a suite pins, and where that line came from.
 *
 * Order: leading doc block → the marker's trailing rationale → the first `describe()` title →
 * MISSING. `@`-tag lines (`@covers`, `@param`, …) are furniture, not properties.
 */
export function extractProperty(source) {
  const beforeDescribe = source.split(/\bdescribe\s*\(/)[0] ?? source;
  const blockStart = beforeDescribe.search(/^\/\*\*/m);
  if (blockStart !== -1) {
    const rest = beforeDescribe.slice(blockStart);
    const end = rest.indexOf("*/");
    const body = (end === -1 ? rest : rest.slice(0, end)).split(/\r?\n/).slice(1);
    for (const raw of body) {
      const line = stripStar(raw).trim();
      if (!line || line.startsWith("@")) continue;
      return { property: truncate(line), source: "doc-block" };
    }
  }

  const marker = source.match(/^\s*\/\/\s*@gate:always-run\s*[—–:-]\s*(.+)$/m);
  if (marker) return { property: truncate(marker[1].trim()), source: "marker-rationale" };

  const describe = source.match(/\bdescribe\s*\(\s*(["'`])([^"'`]+)\1/);
  if (describe) return { property: truncate(describe[2].trim()), source: "describe-title" };

  return { property: "MISSING", source: "none" };
}

function truncate(text) {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= PROPERTY_MAX ? one : `${one.slice(0, PROPERTY_MAX - 1)}…`;
}

/**
 * Words that carry no discriminating signal in a guard's property line, dropped before the
 * near-duplicate comparison so shared filler cannot make two unrelated guards look alike.
 */
const STOPWORDS = new Set(
  "a an and are as at be but by for from has have in into is it its no not of on or so than that the their then there these this to two use used uses using was what when which who why with without".split(
    " ",
  ),
);

/** The comparable word set of a property line, for the near-duplicate heuristic. */
export function propertyTokens(property) {
  return new Set(
    propertyKey(property)
      .split(" ")
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

/**
 * Jaccard overlap of two property lines.
 *
 * The EXACT-text duplicate check #1022 asks for is the honest one, and on this repo it finds
 * nothing: every guard's doc block opens with a sentence written for that guard, so two suites
 * pinning the same property still read differently. That makes the exact check true and useless
 * on its own, so a clearly-labelled near-duplicate pass runs beside it. It is a HEURISTIC and a
 * reading aid — a pair it surfaces still has to be opened and judged, and a pair it misses is not
 * evidence of anything.
 */
export function propertyOverlap(a, b) {
  const A = propertyTokens(a);
  const B = propertyTokens(b);
  if (A.size < 4 || B.size < 4) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared += 1;
  return shared / (A.size + B.size - shared);
}

/** Grouping key: case- and punctuation-insensitive, with issue refs dropped. */
export function propertyKey(property) {
  return property
    .toLowerCase()
    .replace(/\(#\d+\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ git */

function git(args, root) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
}

/** The commit that ADDED each file, following renames. One `git log` per file — there is no
 *  batched form of `--follow`, and ~200 short logs cost a few seconds. */
function introducedAt(path, root) {
  try {
    const out = git(
      ["log", "--diff-filter=A", "--follow", "--date=short", "--format=%h\u001f%ad", "--", path],
      root,
    ).trim();
    if (!out) return null;
    const [sha, date] = out.split(/\r?\n/).pop().split("\u001f");
    return { sha, date };
  } catch {
    return null;
  }
}

/**
 * ONE pass over history, mapping each guard basename to the most recent fix-ish commit naming
 * it. This is the documented PROXY for "last red on master" — see the header.
 */
function lastRedProxyByBasename(basenames, root) {
  /** @type {Map<string, {sha: string, date: string, subject: string}>} */
  const out = new Map();
  const wanted = new Set(basenames);
  let log;
  try {
    log = git(["log", "--date=short", "--format=%h\u001f%ad\u001f%s\u001f%b\u001e"], root);
  } catch {
    return out;
  }
  for (const record of log.split("\u001e")) {
    const text = record.trim();
    if (!text) continue;
    const [sha, date, subject, body = ""] = text.split("\u001f");
    if (!sha || !date) continue;
    const message = `${subject}\n${body}`;
    if (!FIX_ISH_RE.test(message)) continue;
    for (const name of wanted) {
      if (out.has(name)) continue;
      if (message.includes(name)) out.set(name, { sha, date, subject: subject.trim() });
    }
    if (out.size === wanted.size) break;
  }
  return out;
}

/* ------------------------------------------------------------------ durations */

const DURATIONS_REL = "docs/tests/durations.json";

/** Per-file wall time in ms from the committed vitest run, keyed by repo-relative posix path. */
export function loadDurations(root = ROOT) {
  const file = resolve(root, DURATIONS_REL);
  if (!existsSync(file)) return { map: new Map(), present: false };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const map = new Map();
    for (const r of parsed.testResults ?? []) {
      const ms = Number(r.endTime) - Number(r.startTime ?? 0);
      if (!Number.isFinite(ms)) continue;
      map.set(toPosix(r.name), ms);
    }
    return { map, present: true };
  } catch {
    return { map: new Map(), present: false };
  }
}

/* ------------------------------------------------------------------ inventory */

const SLOW_MS = 20_000;

export function buildInventory({ root = ROOT, withGit = true } = {}) {
  const files = collectGuardFiles(root);
  const { map: durations, present: durationsPresent } = loadDurations(root);
  const basenames = files.map((f) => f.path.split("/").pop());
  const redProxy = withGit ? lastRedProxyByBasename(basenames, root) : new Map();

  const rows = files.map((f) => {
    const source = readFileSync(resolve(root, f.path), "utf8");
    const { property, source: propertySource } = extractProperty(source);
    const basename = f.path.split("/").pop();
    const intro = withGit ? introducedAt(f.path, root) : null;
    const red = redProxy.get(basename) ?? null;
    const durationMs = durations.get(f.path) ?? null;
    return {
      file: f.path,
      basename,
      package: f.pkg,
      kinds: [f.alwaysRun ? "always-run" : null, f.ratchet ? "ratchet" : null].filter(Boolean),
      property,
      propertyKey: propertyKey(property),
      propertySource,
      introducedSha: intro?.sha ?? null,
      introducedDate: intro?.date ?? null,
      lastRedProxy: red && { ...red, method: "git-log-fix-commit-naming-the-file" },
      lastRedSource: withGit ? "proxy: git log of fix commits naming the file (no gate-outcome ledger exists)" : "not looked up (--no-git)",
      durationMs,
      durationSource: durationMs == null ? (durationsPresent ? "absent from docs/tests/durations.json" : "docs/tests/durations.json missing") : DURATIONS_REL,
    };
  });

  /** @type {Map<string, typeof rows>} */
  const groups = new Map();
  for (const row of rows) {
    const key = row.property === "MISSING" ? `MISSING::${row.file}` : row.propertyKey;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const duplicates = [...groups.entries()]
    .filter(([key, members]) => members.length > 1 && !key.startsWith("MISSING::"))
    .map(([key, members]) => ({ propertyKey: key, property: members[0].property, files: members.map((m) => m.file) }))
    .sort((a, b) => b.files.length - a.files.length || a.property.localeCompare(b.property));

  const NEAR_DUPLICATE_MIN = 0.5;
  const nearDuplicates = [];
  const stated = rows.filter((r) => r.property !== "MISSING");
  for (let i = 0; i < stated.length; i += 1) {
    for (let j = i + 1; j < stated.length; j += 1) {
      if (stated[i].propertyKey === stated[j].propertyKey) continue; // already an exact duplicate
      const score = propertyOverlap(stated[i].property, stated[j].property);
      if (score >= NEAR_DUPLICATE_MIN) {
        nearDuplicates.push({
          score: Number(score.toFixed(2)),
          files: [stated[i].file, stated[j].file],
          properties: [stated[i].property, stated[j].property],
        });
      }
    }
  }
  nearDuplicates.sort((a, b) => b.score - a.score || a.files[0].localeCompare(b.files[0]));

  const neverRed = withGit
    ? rows
        .filter((r) => !r.lastRedProxy)
        .map((r) => ({ file: r.file, introducedDate: r.introducedDate, property: r.property }))
        .sort((a, b) => (a.introducedDate ?? "").localeCompare(b.introducedDate ?? ""))
    : [];

  const slow = rows
    .filter((r) => r.durationMs != null && r.durationMs > SLOW_MS)
    .map((r) => ({ file: r.file, durationMs: r.durationMs }))
    .sort((a, b) => b.durationMs - a.durationMs);

  const missingProperty = rows.filter((r) => r.property === "MISSING").map((r) => r.file);
  const unmeasured = rows.filter((r) => r.durationMs == null).map((r) => r.file);

  return {
    schema: "guard-inventory 1",
    generatedBy: "pnpm guard:inventory (scripts/guard-inventory.mjs)",
    counts: {
      files: rows.length,
      alwaysRun: rows.filter((r) => r.kinds.includes("always-run")).length,
      ratchet: rows.filter((r) => r.kinds.includes("ratchet")).length,
      both: rows.filter((r) => r.kinds.length === 2).length,
      distinctProperties: new Set(rows.filter((r) => r.property !== "MISSING").map((r) => r.propertyKey)).size,
      missingProperty: missingProperty.length,
      unmeasured: unmeasured.length,
    },
    slowThresholdMs: SLOW_MS,
    withGit,
    rows,
    groups: [...groups.entries()]
      .map(([key, members]) => ({ propertyKey: key, property: members[0].property, files: members.map((m) => m.file) }))
      .sort((a, b) => b.files.length - a.files.length || a.property.localeCompare(b.property)),
    nearDuplicateThreshold: NEAR_DUPLICATE_MIN,
    candidates: {
      duplicates,
      nearDuplicates,
      neverRedSinceIntroduction: neverRed,
      slowerThanThreshold: slow,
      missingProperty,
      unmeasured,
    },
  };
}

/* ------------------------------------------------------------------ markdown */

const fmtMs = (ms) => (ms == null ? "" : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);
const esc = (s) => String(s).replace(/\|/g, "\\|");

export function renderMarkdown(inv) {
  const c = inv.counts;
  const out = [];
  out.push("# Guard inventory");
  out.push("");
  out.push(
    "Generated by `pnpm guard:inventory` (`scripts/guard-inventory.mjs`). **Report only — this",
    "inventory removes nothing.** It exists so the decision about which standing guards to merge or",
    "retire (proposal `2026-09-03-dev-board-vs-deployed-board.md` §3.E) can be made with the whole",
    "set in view instead of one suite at a time.",
  );
  out.push("");
  out.push(
    `**${c.files} files** — ${c.alwaysRun} carry \`@gate:always-run\`, ${c.ratchet} are \`*ratchet*.test.ts\`, ${c.both} are both. ` +
      `${c.distinctProperties} distinct properties; ${c.missingProperty} file(s) state none.`,
  );
  out.push("");
  out.push("## How each column is derived — and what it is NOT");
  out.push("");
  out.push("- **kinds** — the always-run set is imported from `scripts/test-mine.mjs` (`scanAlwaysRunTests`,");
  out.push("  `ALWAYS_RUN_TESTS_DIR`), never re-implemented, so this report cannot describe a different set");
  out.push("  than the gate forces. Ratchets are matched by filename over the same package test trees.");
  out.push("- **property** — first line of the leading `/** … */` block, else the rationale after the");
  out.push("  `@gate:always-run` marker, else the first `describe()` title, else `MISSING`. The source is");
  out.push("  recorded per row: a property read off a describe title is a weaker claim than a written one.");
  out.push("- **introduced** — `git log --diff-filter=A --follow`, the commit that added the file.");
  out.push("- **last red (proxy)** — ⚠ **this repo has no gate-outcome / base-health ledger**: neither the DB");
  out.push("  schema nor `docs/tests/` records which suite was red on master when. The column is therefore a");
  out.push("  PROXY — the most recent commit whose message both names the file and reads like a fix. An empty");
  out.push("  cell means *no such commit was found*, which makes the row a candidate for \"never red since");
  out.push("  introduction\", not a proof of it.");
  out.push("- **wall** — read from `docs/tests/durations.json` (committed output of `pnpm test:durations`).");
  out.push("  Nothing is timed here on purpose: running the guard set to measure it is the cost this");
  out.push("  inventory exists to reduce. Blank = not in that file, listed under *unmeasured* below.");
  out.push("");

  out.push("## Candidates");
  out.push("");
  out.push(
    `Duplicated property (exact): **${inv.candidates.duplicates.length} group(s)**. ` +
      `Overlapping properties (heuristic): **${inv.candidates.nearDuplicates.length} pair(s)**. ` +
      `Never red since introduction (proxy): **${inv.candidates.neverRedSinceIntroduction.length}**. ` +
      `Slower than ${inv.slowThresholdMs / 1000}s: **${inv.candidates.slowerThanThreshold.length}**. ` +
      `No stated property: **${inv.counts.missingProperty}**. Unmeasured: **${inv.counts.unmeasured}**.`,
  );
  out.push("");

  out.push("### Same property pinned more than once");
  out.push("");
  if (inv.candidates.duplicates.length === 0) {
    out.push("_None — every stated property is unique._");
  } else {
    out.push("| property | files |");
    out.push("| --- | --- |");
    for (const d of inv.candidates.duplicates) {
      out.push(`| ${esc(d.property)} | ${d.files.map((f) => `\`${f}\``).join("<br>")} |`);
    }
  }
  out.push("");

  out.push(`### Overlapping properties (heuristic — word overlap ≥ ${inv.nearDuplicateThreshold})`);
  out.push("");
  out.push(
    "The exact check above is the honest one and it finds little: every guard's doc block opens with",
    "a sentence written for that guard, so two suites pinning the same property still read",
    "differently. These pairs merely READ alike — each one still has to be opened and judged, and a",
    "pair this misses is not evidence that no overlap exists.",
  );
  out.push("");
  if (inv.candidates.nearDuplicates.length === 0) {
    out.push("_None above the threshold._");
  } else {
    out.push("| overlap | files | properties |");
    out.push("| --- | --- | --- |");
    for (const d of inv.candidates.nearDuplicates.slice(0, 40)) {
      out.push(
        `| ${d.score} | \`${d.files[0]}\`<br>\`${d.files[1]}\` | ${esc(d.properties[0])}<br>${esc(d.properties[1])} |`,
      );
    }
    if (inv.candidates.nearDuplicates.length > 40) {
      out.push("");
      out.push(`_${inv.candidates.nearDuplicates.length - 40} further pair(s) in \`guard-inventory.json\`._`);
    }
  }
  out.push("");

  out.push("### Never red since introduction (proxy — see the caveat above)");
  out.push("");
  if (inv.candidates.neverRedSinceIntroduction.length === 0) {
    out.push("_None._");
  } else {
    out.push("| file | introduced | property |");
    out.push("| --- | --- | --- |");
    for (const r of inv.candidates.neverRedSinceIntroduction) {
      out.push(`| \`${r.file}\` | ${r.introducedDate ?? "?"} | ${esc(r.property)} |`);
    }
  }
  out.push("");

  out.push(`### Slower than ${inv.slowThresholdMs / 1000}s in the recorded run`);
  out.push("");
  if (inv.candidates.slowerThanThreshold.length === 0) {
    out.push("_None recorded._");
  } else {
    out.push("| file | wall |");
    out.push("| --- | --- |");
    for (const r of inv.candidates.slowerThanThreshold) out.push(`| \`${r.file}\` | ${fmtMs(r.durationMs)} |`);
  }
  out.push("");

  const byFile = new Map(inv.rows.map((r) => [r.file, r]));
  const cells = (row) => [
    `\`${row.file}\``,
    row.kinds.join(", "),
    `${row.introducedDate ?? ""}${row.introducedSha ? ` (\`${row.introducedSha}\`)` : ""}`,
    row.lastRedProxy ? `${row.lastRedProxy.date} (\`${row.lastRedProxy.sha}\`)` : "",
    fmtMs(row.durationMs),
  ];

  const shared = inv.groups.filter((g) => g.files.length > 1 && g.property !== "MISSING");
  out.push("## Properties pinned by more than one suite");
  out.push("");
  if (shared.length === 0) {
    out.push("_None. Every group below holds exactly one file — see the overlap heuristic above for");
    out.push("pairs that read alike without being textually identical._");
    out.push("");
  } else {
    for (const g of shared) {
      out.push(`### ${esc(g.property)} — ${g.files.length} files`);
      out.push("");
      out.push("| file | kinds | introduced | last red (proxy) | wall |");
      out.push("| --- | --- | --- | --- | --- |");
      for (const file of g.files) out.push(`| ${cells(byFile.get(file)).join(" | ")} |`);
      out.push("");
    }
  }

  out.push("## Every guard, ordered by property");
  out.push("");
  out.push(
    "The full inventory. Ordering is the grouping — suites pinning related properties sort next to",
    "each other, which is how a merge candidate is spotted by eye.",
  );
  out.push("");
  out.push("| property | file | kinds | introduced | last red (proxy) | wall |");
  out.push("| --- | --- | --- | --- | --- | --- |");
  for (const row of [...inv.rows].sort((a, b) => a.propertyKey.localeCompare(b.propertyKey) || a.file.localeCompare(b.file))) {
    out.push(`| ${esc(row.property)} | ${cells(row).join(" | ")} |`);
  }
  out.push("");

  out.push("## Unmeasured (no entry in `docs/tests/durations.json`)");
  out.push("");
  out.push(
    inv.candidates.unmeasured.length === 0
      ? "_None._"
      : inv.candidates.unmeasured.map((f) => `- \`${f}\``).join("\n"),
  );
  out.push("");
  return out.join("\n");
}

/* ------------------------------------------------------------------ cli */

function main(argv) {
  const jsonOnly = argv.includes("--json");
  const withGit = !argv.includes("--no-git");
  const outIdx = argv.indexOf("--out");
  const outDir = outIdx === -1 ? resolve(ROOT, "docs/tests") : resolve(process.cwd(), argv[outIdx + 1]);

  const inv = buildInventory({ root: ROOT, withGit });
  if (jsonOnly) {
    process.stdout.write(`${JSON.stringify(inv, null, 2)}\n`);
    return;
  }
  mkdirSync(outDir, { recursive: true });
  const md = resolve(outDir, "guard-inventory.md");
  const json = resolve(outDir, "guard-inventory.json");
  writeFileSync(md, `${renderMarkdown(inv)}`, "utf8");
  writeFileSync(json, `${JSON.stringify(inv, null, 2)}\n`, "utf8");
  console.log(
    `[guard:inventory] ${inv.counts.files} guard file(s) — ` +
      `${inv.counts.alwaysRun} always-run, ${inv.counts.ratchet} ratchet, ${inv.counts.both} both\n` +
      `[guard:inventory] candidates: ${inv.candidates.duplicates.length} duplicate-property group(s), ` +
      `${inv.candidates.neverRedSinceIntroduction.length} never-red (proxy), ` +
      `${inv.candidates.slowerThanThreshold.length} over ${SLOW_MS / 1000}s\n` +
      `[guard:inventory] wrote ${toPosix(relative(ROOT, md))} and ${toPosix(relative(ROOT, json))}`,
  );
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
