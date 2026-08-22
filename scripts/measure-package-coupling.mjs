#!/usr/bin/env node
/**
 * Measure how often one unit of work crosses a package boundary — and WHY (#730).
 *
 * Why this exists as a script rather than a number in a ticket: #730 arrived with the
 * headline "29% of changes touch 2+ packages and `shared` has 14% containment" and a
 * recommendation to split `shared` by consumer. The headline reproduces. The
 * recommendation does not follow from it, and the reason is only visible in the
 * ATTRIBUTION — which of the crossing commits involve `shared` at all, and which part of
 * `shared` they touch. A monorepo whose `shared` package holds the DB schema and the wire
 * DTOs will always show low containment for `shared`, because that is what those two are
 * for. Low containment is therefore not evidence of a boundary defect on its own, and the
 * only way to keep that straight is to re-derive the split every time rather than quote
 * the percentage.
 *
 * Usage:
 *   node scripts/measure-package-coupling.mjs            # full history
 *   node scripts/measure-package-coupling.mjs --since=2026-06-01
 *
 * Reads git history only — no DB, no network, no build. Behavioural, so the numbers move
 * as history grows; compare runs by re-running, not by trusting a recorded figure.
 */
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const since = args.find((a) => a.startsWith("--since="))?.slice("--since=".length) ?? null;

/** Packages that hold shippable code. `e2e`/`desktop` are reported but excluded from the
 *  "genuine production crossing" figure — an e2e suite touching client+server is a test
 *  spanning two processes, which is its job, not a boundary being violated. */
const CODE_PACKAGES = new Set(["client", "server", "shared", "mcp-server", "e2e", "desktop"]);
const TEST_PACKAGES = new Set(["e2e", "desktop"]);

const packageOf = (file) => /^packages\/([^/]+)\//.exec(file)?.[1] ?? "root";

const isTestFile = (f) => /(__tests__|\.test\.|\.spec\.)/.test(f);
/** Files that cross a boundary MECHANICALLY: generated bookkeeping, manifests, config, docs.
 *  A migration bumps `drizzle/meta/_journal.json` whether or not the design is sound. */
const isMechanical = (f) =>
  /drizzle\/meta\//.test(f) ||
  /\.sql$/.test(f) ||
  /package\.json$/.test(f) ||
  /(vitest|tsconfig|vite|drizzle)\.config\.[^/]*$/.test(f) ||
  /\.md$/.test(f);

function readCommits() {
  const marker = "COMMIT";
  const gitArgs = ["log", "--no-merges", `--pretty=format:${marker}%H`, "--name-only"];
  if (since) gitArgs.push(`--since=${since}`);
  const raw = execFileSync("git", gitArgs, { maxBuffer: 1 << 29, encoding: "utf8" });
  const out = [];
  for (const chunk of raw.split(marker)) {
    const text = chunk.trim();
    if (!text) continue;
    const lines = text.split("\n");
    out.push({ sha: lines[0], files: lines.slice(1).map((l) => l.trim()).filter(Boolean) });
  }
  return out;
}

const pct = (n, of) => `${((n / of) * 100).toFixed(1)}%`;

function spread(commits, keep) {
  let total = 0;
  let multi = 0;
  let three = 0;
  let sum = 0;
  let worst = 0;
  for (const c of commits) {
    const pkgs = new Set(c.files.filter((f) => CODE_PACKAGES.has(packageOf(f)) && keep(f)).map(packageOf));
    if (pkgs.size === 0) continue;
    total++;
    sum += pkgs.size;
    worst = Math.max(worst, pkgs.size);
    if (pkgs.size >= 2) multi++;
    if (pkgs.size >= 3) three++;
  }
  return { total, multi, three, mean: sum / total, worst };
}

function report(label, keep) {
  const s = spread(commits, keep);
  console.log(
    `  ${label.padEnd(46)} ${String(s.total).padStart(5)} commits  >=2pkg ${pct(s.multi, s.total).padStart(6)}` +
      `  >=3pkg ${pct(s.three, s.total).padStart(6)}  mean ${s.mean.toFixed(2)}  worst ${s.worst}`,
  );
}

const commits = readCommits();
console.log(`\n# Cross-package co-change (${commits.length} non-merge commits${since ? `, since ${since}` : ""})\n`);

console.log("## How wide is one commit\n");
report("all code files", () => true);
report("minus test files", (f) => !isTestFile(f));
report("minus mechanical (journal/sql/manifest/config/md)", (f) => !isMechanical(f));
report("minus both", (f) => !isTestFile(f) && !isMechanical(f));
const productionOnly = (f) => !isTestFile(f) && !isMechanical(f) && !TEST_PACKAGES.has(packageOf(f));
report("minus both, and the test-only packages", productionOnly);

// ---- Which package PAIRS actually move together
const pairs = new Map();
let withPairs = 0;
for (const c of commits) {
  const pkgs = [...new Set(c.files.filter((f) => CODE_PACKAGES.has(packageOf(f))).map(packageOf))].sort();
  if (pkgs.length === 0) continue;
  withPairs++;
  for (let i = 0; i < pkgs.length; i++) {
    for (let j = i + 1; j < pkgs.length; j++) {
      const key = `${pkgs[i]} <-> ${pkgs[j]}`;
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
    }
  }
}
console.log("\n## Package pairs that move together (all code files)\n");
for (const [key, n] of [...pairs].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${key.padEnd(26)} ${String(n).padStart(5)}  ${pct(n, withPairs)} of commits`);
}

// ---- Containment: of a package's file-pairs that change together, how many stay inside it
console.log("\n## Containment (share of a package's co-changing file pairs that stay inside it)\n");
const inside = new Map();
const crossing = new Map();
for (const c of commits) {
  const files = c.files.filter((f) => CODE_PACKAGES.has(packageOf(f)));
  // A sweeping commit (a rename, a lint pass) would dominate the pair counts.
  if (files.length < 2 || files.length > 60) continue;
  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      const a = packageOf(files[i]);
      const b = packageOf(files[j]);
      if (a === b) inside.set(a, (inside.get(a) ?? 0) + 1);
      else {
        crossing.set(a, (crossing.get(a) ?? 0) + 1);
        crossing.set(b, (crossing.get(b) ?? 0) + 1);
      }
    }
  }
}
for (const p of CODE_PACKAGES) {
  const i = inside.get(p) ?? 0;
  const o = crossing.get(p) ?? 0;
  if (i + o === 0) continue;
  console.log(`  ${p.padEnd(12)} ${pct(i, i + o).padStart(6)}   (inside ${i}, crossing ${o})`);
}

// ---- The attribution that decides whether a boundary is at fault
const sharedArea = (f) => /^packages\/shared\/(?:src\/)?([^/]+)/.exec(f)?.[1] ?? null;
const why = new Map();
let genuine = 0;
for (const c of commits) {
  const files = c.files.filter((f) => CODE_PACKAGES.has(packageOf(f)) && productionOnly(f));
  if (new Set(files.map(packageOf)).size < 2) continue;
  genuine++;
  const areas = new Set(files.filter((f) => packageOf(f) === "shared").map(sharedArea).filter(Boolean));
  const key = areas.size ? [...areas].sort().join("+") : "(no shared file at all)";
  why.set(key, (why.get(key) ?? 0) + 1);
}
console.log(`\n## Of the ${genuine} genuine production crossings, what part of shared is involved\n`);
for (const [key, n] of [...why].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(5)}  ${pct(n, genuine).padStart(6)}  ${key}`);
}
console.log(
  `\nRead this table before acting on a containment number. "(no shared file at all)" is the\n` +
    `client<->server HTTP boundary — two processes, which no rearrangement of packages can\n` +
    `collapse (its missing ENFORCEMENT is #780, a different problem). \`schema\` and \`types\`\n` +
    `are the DB schema and the wire contract: deliberately one declaration with several\n` +
    `consumers. Only \`lib\` is a population where a module can plausibly be in the wrong\n` +
    `package, and \`shared-lib-single-consumer-ratchet.test.ts\` is what polices that.\n`,
);
