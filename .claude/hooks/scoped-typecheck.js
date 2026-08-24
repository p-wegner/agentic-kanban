#!/usr/bin/env node
/**
 * Scoped typecheck — typecheck only the PACKAGES this session actually edited.
 *
 * Sibling of scoped-vitest.js (#280/#278), for the same reason and with the same
 * contract. The Stop check used to run `pnpm typecheck`, which is the whole
 * monorepo in sequence — shared, server, mcp-server, client, e2e, behind an
 * ensure-shared-fresh build. Measured on this box: shared 6s, server 29s, and the
 * full chain does not fit the 120s budget it was given under load, so it was
 * killed on every run and reported nothing. A blocking check that can only ever
 * be killed is worse than no check: it is pure latency plus a misleading veto.
 *
 * Editing one server file does not need the client typechecked. So: map the
 * edited files to their owning packages and typecheck only those.
 *
 * THE ONE CASE SCOPING GETS WRONG, handled explicitly: `packages/shared` is a
 * dependency of every other package, so a change there can break a dependent that
 * was never edited — exactly the blind spot that let master go red under the
 * scoped merge gate (#816: a hand-rolled mock is invisible to import-graph
 * scoping). When shared is among the edited packages this therefore escalates to
 * the FULL `pnpm typecheck` rather than pretending the scope is safe. That is the
 * expensive path, and it is the honest cost of touching shared.
 *
 * Contract with smart-hooks-runner.js (identical to scoped-vitest.js):
 *   - reads the edited-file list from SMART_HOOKS_EDITED_FILES (JSON array of
 *     repo-relative paths); exits 0 when nothing is in scope,
 *   - exit 0 = pass, non-zero + stderr = fail (the runner surfaces the output).
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  capacityHold,
  budgetMs,
  hitBudget,
  killTree,
  budgetMessage,
} = require("./machine-capacity.js");

// Repo-relative package dir -> the command that typechecks just that package.
// Longest prefix wins, so `packages/server/...` never matches a shorter sibling.
// Commands mirror the per-package halves of the root `typecheck` script.
const PACKAGES = [
  { dir: "packages/shared", args: ["--filter", "shared", "typecheck"], shared: true },
  { dir: "packages/server", args: ["--filter", "agentic-kanban", "exec", "tsc", "--noEmit"] },
  { dir: "packages/mcp-server", args: ["--filter", "@agentic-kanban/mcp-server", "exec", "tsc", "--noEmit"] },
  { dir: "packages/client", args: ["--filter", "@agentic-kanban/client", "exec", "tsc", "--noEmit"] },
  { dir: "packages/e2e", args: ["--filter", "@agentic-kanban/e2e", "exec", "tsc", "--noEmit"] },
];

function repoRoot() {
  // The hook lives at <root>/.claude/hooks/ — resolve locally rather than
  // spawning git, since every avoided spawn matters on this path (#279).
  return path.resolve(__dirname, "..", "..");
}

function editedFiles() {
  const raw = process.env.SMART_HOOKS_EDITED_FILES;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((f) => typeof f === "string") : [];
  } catch {
    return [];
  }
}

function packageFor(relPath) {
  const normalized = relPath.replace(/\\/g, "/");
  let best = null;
  for (const pkg of PACKAGES) {
    if (normalized.startsWith(`${pkg.dir}/`) && (!best || pkg.dir.length > best.dir.length)) {
      best = pkg;
    }
  }
  return best;
}

function run(root, args, timeout) {
  const result = spawnSync("pnpm", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    shell: process.platform === "win32",
    timeout,
  });
  // shell:true means the direct child is cmd.exe; reap the tsc under it too.
  if (hitBudget(result)) killTree(result.pid);
  return result;
}

/**
 * tsc reports one diagnostic per line as `file(line,col): error TSxxxx: ...`.
 * Keep those and drop the rest, so a failure says what broke instead of burying
 * it — the lesson scoped-vitest.js records about blind output tails.
 */
function summarize(stdout, stderr, maxChars = 3000) {
  const lines = [...String(stdout).split("\n"), ...String(stderr).split("\n")]
    .filter((l) => /error TS\d+|\berror\b/i.test(l))
    .filter((l, i, all) => all.indexOf(l) === i);
  const text = lines.length ? lines.join("\n") : (String(stdout).trim() || String(stderr).trim());
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n… (truncated)`;
}

function main() {
  const root = repoRoot();
  const files = editedFiles();
  if (files.length === 0) process.exit(0);

  const touched = new Map();
  for (const file of files) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const pkg = packageFor(file);
    if (!pkg) continue;
    // A file edited then deleted would make tsc's project unhappy for no reason.
    if (!fs.existsSync(path.join(root, file))) continue;
    touched.set(pkg.dir, pkg);
  }
  if (touched.size === 0) process.exit(0);

  const escalate = [...touched.values()].some((p) => p.shared);
  const label = escalate
    ? "Typecheck (full — shared was edited)"
    : `Typecheck (${touched.size} package(s))`;

  const gate = capacityHold({ label });
  if (gate.hold) {
    console.error(`[smart-hooks] ${gate.reason}`);
    process.exit(0); // a machine condition is not a code failure
  }

  // shared feeds every other package: scoping is unsound here, so run the lot.
  const jobs = escalate ? [{ dir: "(all)", args: ["typecheck"] }] : [...touched.values()];

  // Same self-imposed wall-clock budget as scoped-vitest.js, and for the same
  // reason: the escalated full-monorepo path is exactly the one that never fit
  // its old 120s timeout and was killed on every run (board #868), reporting
  // nothing at all for the latency it cost.
  const budget = budgetMs("SCOPED_TYPECHECK_BUDGET_MS", escalate ? 180_000 : 120_000);
  const deadline = Date.now() + budget;
  let overBudget = false;

  const failures = [];
  for (const job of jobs) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      overBudget = true;
      break;
    }
    const result = run(root, job.args, remaining);
    if (hitBudget(result)) {
      overBudget = true;
      break;
    }
    if (result.status !== 0) {
      failures.push(`--- ${job.dir} ---\n${summarize(result.stdout, result.stderr)}`);
    }
  }

  if (failures.length > 0) {
    console.error(
      `Typecheck failed for ${failures.length} package(s). Scope: ${escalate
        ? "the FULL monorepo, because packages/shared was edited and every package depends on it"
        : [...touched.keys()].join(", ") + " (only the packages this session edited)"}.\n`,
    );
    console.error(failures.join("\n\n"));
    process.exit(1);
  }
  if (overBudget) {
    // After real failures, for the same reason as scoped-vitest.js.
    console.error(`[smart-hooks] ${budgetMessage(label, budget)}`);
  }
  process.exit(0);
}

main();
