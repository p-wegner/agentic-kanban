#!/usr/bin/env node
/**
 * `pnpm check:arch`, as a script so it can report its own duration to the merge gate (#988).
 *
 * It was three commands chained with `&&` inside the package script. That is still exactly what
 * it runs — the sub-steps, their order and their fail-fast behaviour are unchanged, and this file
 * deliberately adds no scoping. #988 measured the scoping option and declined it: dependency-
 * cruiser's rules are about EDGES, and an edge from an unchanged file into a changed one is
 * precisely what a changed-file list hides, so narrowing it would buy under 10s against a real
 * correctness risk. Revisit only if arch's share of the floor grows.
 *
 * What it adds is the `[gate:step]` line the gate parses (`verify-step-timings.ts`). An `&&`
 * chain in a package script has nowhere to hang a timer, which is the whole reason the gate's
 * verdict could not name where its time went.
 *
 * The per-sub-step breakdown is printed for a human too, because #988's premise — god-modules 2s,
 * lint:arch 12s, mcp-catalog-parity 11s — was measured by hand once and would otherwise have to
 * be re-measured by hand the next time someone asks whether scoping is worth it yet.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPnpm } from "./pnpm-exec.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function awaitExit(child) {
  return new Promise((resolve) => {
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/**
 * The three sub-steps, in the order the `&&` chain ran them. `god-modules` first because it is
 * the cheapest and the most likely to be the thing a refactor just broke.
 */
const STEPS = [
  {
    label: "god-modules",
    run: () => awaitExit(spawn(process.execPath, [join(REPO_ROOT, "scripts", "check-god-modules.mjs")], { cwd: REPO_ROOT, stdio: "inherit", windowsHide: true })),
  },
  {
    label: "lint:arch",
    run: () => awaitExit(spawnPnpm(["lint:arch"], { cwd: REPO_ROOT, stdio: "inherit" })),
  },
  {
    label: "mcp-catalog-parity",
    run: () =>
      awaitExit(
        spawnPnpm(
          ["--filter", "@agentic-kanban/mcp-server", "exec", "vitest", "run", "src/__tests__/mcp-catalog-parity.test.ts"],
          { cwd: REPO_ROOT, stdio: "inherit" },
        ),
      ),
  },
];

async function main() {
  const startedAt = Date.now();
  const timings = [];
  let failedLabel = null;
  for (const step of STEPS) {
    const stepStartedAt = Date.now();
    const code = await step.run();
    timings.push({ label: step.label, durationMs: Date.now() - stepStartedAt, code });
    // Fail-fast, exactly like the `&&` chain it replaces: a broken layering rule makes the
    // parity test's verdict uninteresting, and running it anyway would only slow the red path.
    if (code !== 0) {
      failedLabel = step.label;
      break;
    }
  }
  const totalMs = Date.now() - startedAt;

  const parts = timings.map((t) => `${t.label} ${Math.round(t.durationMs / 1000)}s${t.code === 0 ? "" : " FAILED"}`);
  console.log(`[check:arch] ${Math.round(totalMs / 1000)}s total: ${parts.join(", ")}`);
  // Only on the green path. A chain that stopped at its first sub-step ran a FRACTION of the
  // work, and reporting that fraction's clock as `arch 2s` would understate the floor — the
  // flattering direction, and the one the gate message's honesty rule exists to rule out. A
  // failing gate never reaches the passing message anyway.
  if (!failedLabel) console.log(`[gate:step] name=arch seconds=${Math.round(totalMs / 1000)}`);

  if (failedLabel) {
    console.error(`[check:arch] FAILED at ${failedLabel}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[check:arch] crashed:", err);
  process.exit(1);
});
