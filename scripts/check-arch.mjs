#!/usr/bin/env node
/**
 * `pnpm check:arch`, as a script so it can report its own duration to the merge gate (#988).
 *
 * It was three commands chained with `&&` inside the package script; the sub-steps, their order
 * and their fail-fast behaviour are unchanged. What this file adds is the `[gate:step]` line the
 * gate parses (`verify-step-timings.ts`), and — since #1052 — a TERRITORY per sub-step, so a diff
 * that cannot move an import edge or an MCP tool definition doesn't pay for the check that only
 * exists to catch that.
 *
 * **#988 measured the scoping option and declined it, and #1052 reverses that call.** #988's
 * reasoning was sound in principle (an edge from an unchanged file into a changed one is
 * invisible to a changed-file list) but #1052 measured something #988 didn't: on 2026-09-05/06,
 * EVERY gate death on this board happened inside this script, before `test:mine` was ever
 * reached — so the impact tier, the whole mechanism built to make the gate affordable, had no
 * opportunity to do anything on those runs. `lint:arch` (depcruise, 18-69s) and
 * `mcp-catalog-parity` (10-56s) are the two of three sub-steps with an obvious territory.
 * `god-modules` stayed unconditional under #1052 because it reads every file's line count; #1232
 * gave it the territory that reading actually has — every non-test `.ts`/`.tsx` under a package's
 * `src/` — so a docs/tests/scripts-only diff no longer pays it either.
 *
 * `KANBAN_ARCH_CHANGED_FILES` (comma-separated, repo-relative, set by the gate — see
 * `buildVerifyEnv` in `pre-merge-gate-tier.ts`) carries the diff. Unset or empty means "I cannot
 * see the diff" — every step still runs, the same fail-open direction `@gate:always-run`'s
 * `when:` clause uses (a precondition that narrowed on an unknown change set would silently claim
 * a floor of nothing). A skipped step is always NAMED in the summary line, never dropped
 * silently — CLAUDE.md's rule that a level may only weaken verification VISIBLY applies here too.
 */
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPnpm } from "./pnpm-exec.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function awaitExit(child, label) {
  return new Promise((resolve) => {
    // A spawn that never started fails the step exactly like a non-zero exit — but silently it is
    // indistinguishable from the sub-step running and failing, and the two have completely
    // different fixes (a missing pnpm on PATH vs a real layering violation). Name the cause.
    child.on("error", (err) => {
      console.error(`[check:arch] could not start ${label}: ${err.message}`);
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/**
 * Mirrors `matchesPathGlob` in `scripts/test-mine.mjs` / `matchesGuardGlob` in
 * `always-run-guard-floor.ts`: `**` spans path segments, `*` does not. A third copy rather than
 * an import because this script deliberately imports only Node built-ins + the local pnpm
 * wrapper (so it works before `pnpm install` has run anything else) and cannot depend on either
 * package's build output.
 */
export function matchesPathGlob(glob, relPath) {
  const rx = glob
    .replace(/\\/g, "/")
    .split("/")
    .map((seg) => (seg === "**" ? "(?:.*)" : seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")))
    .join("/")
    // `**' + '/x` must also match a bare `x` at the root.
    .replace(/\(\?:\.\*\)\//g, "(?:.*/)?");
  return new RegExp(`^${rx}$`).test(relPath.replace(/\\/g, "/"));
}

/** Mirrors `.dependency-cruiser.cjs`'s own `exclude.path`: these carry no edge it enforces. */
export function isArchRelevantFile(relPath) {
  if (/(^|\/)__tests__\//.test(relPath)) return false;
  if (/\.test\.(ts|tsx)$/.test(relPath)) return false;
  if (/\/drizzle\//.test(relPath)) return false;
  if (/\.d\.ts$/.test(relPath)) return false;
  return true;
}

/**
 * Mirrors `isExcluded` + the `.ts`/`.tsx` filter in `scripts/check-god-modules.mjs`: the script
 * measures every non-test TypeScript module under `packages/<pkg>/src`, so only such a file (or
 * the script that grandfathers them) can change its verdict.
 */
export function isGodModuleRelevantFile(relPath) {
  if (relPath === "scripts/check-god-modules.mjs") return true;
  if (!/^packages\/[^/]+\/src\//.test(relPath)) return false;
  if (!/\.tsx?$/.test(relPath)) return false;
  if (/(^|\/)__tests__\//.test(relPath)) return false;
  if (/\.(test|spec)\.tsx?$/.test(relPath)) return false;
  if (/\.d\.ts$/.test(relPath)) return false;
  return true;
}

/**
 * Territory per scoped sub-step (#1052). `god-modules` joined the scoped set with #1232: it
 * reads every package's non-test `.ts`/`.tsx` under `src/` and nothing else, so a diff with no
 * such file (docs, tests, scripts, config) cannot move its verdict. A CHANGED-PACKAGE scope
 * would be narrower still and was deliberately not taken: the cohesion baseline keys on paths
 * across packages, and a single reading of the whole set is cheaper (~5s) than the argument
 * that a per-package reading is equivalent.
 */
export const STEP_TERRITORY = {
  "god-modules": {
    when: ["packages/**", "scripts/check-god-modules.mjs"],
    filter: isGodModuleRelevantFile,
    reason: "no source module changes",
  },
  "lint:arch": {
    when: ["packages/**", "scripts/**", ".dependency-cruiser.cjs"],
    filter: isArchRelevantFile,
    reason: "no import changes",
  },
  "mcp-catalog-parity": {
    when: [
      "packages/mcp-server/src/index.ts",
      "packages/mcp-server/src/tools/**",
      "packages/shared/src/lib/mcp-tool-definitions.ts",
    ],
    reason: "no MCP tool/catalog changes",
  },
};

/**
 * Does `label`'s territory intersect the diff? `changedFiles: []` means the diff is UNKNOWN
 * (env var unset, or the gate couldn't read it) — that runs everything, never nothing.
 */
export function stepApplies(label, changedFiles) {
  const territory = STEP_TERRITORY[label];
  if (!territory) return true;
  if (changedFiles.length === 0) return true;
  const candidates = territory.filter ? changedFiles.filter(territory.filter) : changedFiles;
  return candidates.some((f) => territory.when.some((g) => matchesPathGlob(g, f)));
}

/**
 * The three sub-steps, in the order the `&&` chain ran them. `god-modules` first because it is
 * the cheapest and the most likely to be the thing a refactor just broke.
 */
const STEPS = [
  {
    label: "god-modules",
    run: () => awaitExit(spawn(process.execPath, [join(REPO_ROOT, "scripts", "check-god-modules.mjs")], { cwd: REPO_ROOT, stdio: "inherit", windowsHide: true }), "god-modules"),
  },
  {
    label: "lint:arch",
    run: () => awaitExit(spawnPnpm(["lint:arch"], { cwd: REPO_ROOT, stdio: "inherit" }), "lint:arch"),
  },
  {
    label: "mcp-catalog-parity",
    run: () =>
      awaitExit(
        spawnPnpm(
          ["--filter", "@agentic-kanban/mcp-server", "exec", "vitest", "run", "src/__tests__/mcp-catalog-parity.test.ts"],
          { cwd: REPO_ROOT, stdio: "inherit" },
        ),
        "mcp-catalog-parity",
      ),
  },
];

export async function main() {
  const changedFiles = (process.env.KANBAN_ARCH_CHANGED_FILES || "")
    .split(",")
    .map((f) => f.trim().replace(/\\/g, "/"))
    .filter(Boolean);

  const startedAt = Date.now();
  const timings = [];
  const skipped = [];
  let failedLabel = null;
  for (const step of STEPS) {
    if (!stepApplies(step.label, changedFiles)) {
      skipped.push({ label: step.label, reason: STEP_TERRITORY[step.label].reason });
      continue;
    }
    const stepStartedAt = Date.now();
    const code = await step.run();
    timings.push({ label: step.label, durationMs: Date.now() - stepStartedAt, code });
    // #1149: exit 3 from `god-modules` means "could not verify cohesion here" (no typescript
    // in this worktree), NOT "a violation was found" — the script already printed its own
    // UNVERIFIED explanation to stderr, which the gate's failure-message shaping picks up
    // downstream. It must still stop the chain (later steps assume a clean tree) and it must
    // still exit non-zero (a foreign caller has no third state to check for), but it is named
    // here distinctly rather than folded into the same "FAILED at" wording as a real breach.
    if (code === 3 && step.label === "god-modules") {
      console.error(`[check:arch] UNVERIFIED at ${step.label} — see its own output above`);
      process.exitCode = 3;
      return;
    }
    // Fail-fast, exactly like the `&&` chain it replaces: a broken layering rule makes the
    // parity test's verdict uninteresting, and running it anyway would only slow the red path.
    if (code !== 0) {
      failedLabel = step.label;
      break;
    }
  }
  const totalMs = Date.now() - startedAt;

  const ranParts = timings.map((t) => `${t.label} ${Math.round(t.durationMs / 1000)}s${t.code === 0 ? "" : " FAILED"}`);
  const skipReasonSummary = skipped.length
    ? ` (${[...new Set(skipped.map((s) => s.reason))].join("; ")})`
    : "";
  const skipPart = skipped.length ? [`${skipped.length} step(s) skipped: ${skipped.map((s) => s.label).join(", ")}${skipReasonSummary}`] : [];
  console.log(`[check:arch] ${Math.round(totalMs / 1000)}s total: ${[...ranParts, ...skipPart].join(", ")}`);
  // Only on the green path. A chain that stopped at its first sub-step ran a FRACTION of the
  // work, and reporting that fraction's clock as `arch 2s` would understate the floor — the
  // flattering direction, and the one the gate message's honesty rule exists to rule out. A
  // failing gate never reaches the passing message anyway.
  //
  // `scope=` carries the skip into the GATE's own one-line verdict (`buildStepTimingNote`
  // reads it verbatim), not just this script's own log — a skip visible only here would be
  // invisible to whoever reads the merge comment, which is exactly the silent-narrowing shape
  // CLAUDE.md's "a level may only weaken verification VISIBLY" rule forbids. Omitted when
  // nothing was skipped, same as every other step's `scope` field.
  if (!failedLabel) {
    // Two separate literal templates (not one with a conditionally-empty hole) so the STATIC
    // text around each hole is correct either way — `verify-step-timings.test.ts`'s emitter
    // round-trip guard realizes every `${…}` hole independently and would not catch a hole
    // whose OWN runtime value supplies the space/quote the parser needs, only a missing
    // literal one (#988's whole point).
    if (skipped.length) {
      const reason = skipReasonSummary.trim().replace(/^\(|\)$/g, "");
      console.log(
        `[gate:step] name=arch seconds=${Math.round(totalMs / 1000)} scope="${skipped.map((s) => s.label).join("+")} skipped: ${reason}"`,
      );
    } else {
      console.log(`[gate:step] name=arch seconds=${Math.round(totalMs / 1000)}`);
    }
  }

  if (failedLabel) {
    console.error(`[check:arch] FAILED at ${failedLabel}`);
    process.exit(1);
  }
}

// Guarded so this module can be imported for its pure functions (territory matching, in
// tests) without spawning its own children — mirrors `scripts/test-mine.mjs`'s entry check.
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[check:arch] crashed:", err);
    process.exit(1);
  });
}
