#!/usr/bin/env node
/**
 * The monorepo typecheck, run with bounded concurrency and an incremental cache (#980).
 *
 * It used to be five `tsc --noEmit` invocations chained with `&&` inside the `typecheck`
 * package script. Two things were wrong with that once the test-impact budget (#966/#967)
 * bounded the TEST half of the pre-merge gate at 120s:
 *
 *  - **It was serial.** Measured on this repo (2026-09-01, idle box): server 30s, client 17s,
 *    mcp-server 9s, shared 6s, e2e 4s — 66s of work taken one at a time. The five packages do
 *    not depend on each other's typecheck, so the ordering bought nothing.
 *  - **It threw the result away.** `--noEmit` without `--incremental` re-reads the world every
 *    run, so a re-run after a one-file edit cost the same as the first.
 *
 * Both are fixed here, and the reason this is a script rather than a longer `&&` chain is the
 * third requirement: the gate's FLOOR has to stay measured. It prints each package's duration
 * and the total, so `typecheck 35s` sits next to `tests 118s` in a gate log and the next person
 * arguing about where the gate's time goes has the numbers instead of an impression.
 *
 * **Concurrency is capped, and low on purpose.** Each `tsc` peaks around 0.5-1 GB, and this box
 * routinely runs several agents plus their builders; a worker-per-core default is how one
 * careless run takes the machine down. Two is the default (~1.4 GB peak, still cutting the wall
 * clock roughly in half because the 30s server package dominates). `KANBAN_TYPECHECK_WORKERS`
 * overrides it.
 *
 * **The cache lives under `node_modules/.cache/`** — already gitignored, already per-worktree,
 * and discarded with the install it belongs to. A fresh worktree therefore starts cold and pays
 * the full price; that is correct rather than unfortunate, because a build-info file seeded from
 * another checkout is a claim about inputs this one has never read.
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPnpm } from "./pnpm-exec.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** `filter` is the pnpm workspace filter; `label` is what the summary calls it. */
const PACKAGES = [
  { label: "server", filter: "agentic-kanban", dir: "packages/server" },
  { label: "client", filter: "@agentic-kanban/client", dir: "packages/client" },
  { label: "mcp-server", filter: "@agentic-kanban/mcp-server", dir: "packages/mcp-server" },
  { label: "shared", filter: "@agentic-kanban/shared", dir: "packages/shared" },
  { label: "e2e", filter: "@agentic-kanban/e2e", dir: "packages/e2e" },
];

const workers = Math.max(1, Number(process.env.KANBAN_TYPECHECK_WORKERS) || 2);

/** Await a spawned child, inheriting stdio so a type error is reported where it happens. */
function awaitExit(child) {
  return new Promise((resolve) => {
    child.on("error", (err) => resolve({ code: 1, error: err }));
    child.on("close", (code) => resolve({ code: code ?? 1, error: null }));
  });
}

/**
 * pnpm goes through `spawnPnpm`, not a bare `spawn("pnpm", ...)`: on Windows the common
 * install methods create only `pnpm.cmd`/`pnpm.ps1`, so a bare spawn dies with
 * `spawn pnpm ENOENT`. That is the same `scripts/pnpm-exec.mjs` seam every other launcher
 * here uses, and re-deriving it locally is how the ENOENT came back the first time.
 */
function runPnpm(args, cwd) {
  return awaitExit(spawnPnpm(args, { cwd, stdio: "inherit" }));
}

function runNode(args, cwd) {
  return awaitExit(spawn(process.execPath, args, { cwd, stdio: "inherit", windowsHide: true }));
}

async function typecheckPackage(pkg) {
  const cacheDir = join(REPO_ROOT, pkg.dir, "node_modules", ".cache");
  mkdirSync(cacheDir, { recursive: true });
  const startedAt = Date.now();
  const { code } = await runPnpm(
    [
      "--filter",
      pkg.filter,
      "exec",
      "tsc",
      "--noEmit",
      // Allowed with --noEmit since TS 5.6; this repo is on 5.9.
      "--incremental",
      // RELATIVE on purpose: `pnpm --filter … exec` runs in the package directory, and a
      // relative path cannot be mangled by a clone whose absolute path contains a space.
      "--tsBuildInfoFile",
      "node_modules/.cache/typecheck.tsbuildinfo",
    ],
    REPO_ROOT,
  );
  return { label: pkg.label, code, durationMs: Date.now() - startedAt };
}

async function main() {
  // The shared package's `dist/` is what the other packages' type resolution reads, so it is
  // refreshed BEFORE anything runs — the same reason the old `&&` chain led with it.
  const prepared = await runNode([join(REPO_ROOT, "scripts", "ensure-shared-fresh.mjs")], REPO_ROOT);
  if (prepared.code !== 0) {
    console.error("[typecheck] ensure-shared-fresh failed — aborting before any package ran");
    process.exit(prepared.code);
  }

  const startedAt = Date.now();
  const queue = [...PACKAGES];
  const results = [];
  await Promise.all(
    Array.from({ length: Math.min(workers, queue.length) }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        results.push(await typecheckPackage(next));
      }
    }),
  );
  const totalMs = Date.now() - startedAt;

  // Slowest first: the summary's job is to name what the floor is made of.
  const ordered = [...results].sort((a, b) => b.durationMs - a.durationMs);
  const parts = ordered.map((r) => `${r.label} ${Math.round(r.durationMs / 1000)}s${r.code === 0 ? "" : " FAILED"}`);
  console.log(`[typecheck] ${Math.round(totalMs / 1000)}s total across ${results.length} package(s), ${workers} worker(s): ${parts.join(", ")}`);

  const failed = results.filter((r) => r.code !== 0);
  if (failed.length > 0) {
    console.error(`[typecheck] FAILED: ${failed.map((r) => r.label).join(", ")}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[typecheck] crashed:", err);
  process.exit(1);
});
