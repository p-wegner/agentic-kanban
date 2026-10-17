// @gate:always-run when:packages/server/src/** â€” walks the server src import graph from the worker CLI entry; no import edge to it (#647).
// The `agentic-kanban-worker` binary exists so a worker machine can run the
// daemon WITHOUT the board's command tree â€” no database layer, no server
// services. That promise is an import-graph property, and import graphs rot
// silently: one convenient `import { thing } from "../services/â€¦"` re-couples
// everything and nothing visibly breaks. So walk the graph and assert it.
// @gate:static — source-scanning ratchet: runs in the static tier (`pnpm check:static`, #1514), never held.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SERVER_SRC = resolve(__dirname, "..");
const ENTRY = resolve(SERVER_SRC, "worker/worker-cli.ts");

/** Modules whose presence in the graph means the board layer got pulled in. */
const FORBIDDEN_LOCAL = [
  "src/db/",
  "src/services/worker-fleet.service",
  "src/services/agent-remote.service",
  "src/services/git-http.service",
  "src/repositories/",
  "src/routes/",
  "src/startup/",
];

/** npm packages a worker must never need at runtime. */
const FORBIDDEN_PACKAGES = [
  "drizzle-orm",
  "@libsql/client",
  "@modelcontextprotocol/sdk",
  "@anthropic-ai/claude-agent-sdk",
  "hono",
  "ts-morph",
];

function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  // Static `import ... from "x"` / `export ... from "x"` plus dynamic import("x").
  const specs: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)[^;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const spec = m[1] ?? m[2];
    if (spec) specs.push(spec);
  }
  return specs;
}

function resolveLocal(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec).replace(/\.js$/, "");
  for (const candidate of [`${base}.ts`, resolve(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every local module reachable from the entry, plus every bare package specifier. */
function walk(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const spec of importsOf(file)) {
      const local = resolveLocal(file, spec);
      if (local) {
        queue.push(local);
      } else if (!spec.startsWith("node:")) {
        packages.add(spec);
      }
    }
  }
  return { files, packages };
}

describe("agentic-kanban-worker binary isolation", () => {
  const { files, packages } = walk(ENTRY);
  const normalized = [...files].map((f) => f.replace(/\\/g, "/"));

  it("reaches a small, self-contained module graph", () => {
    expect(existsSync(ENTRY)).toBe(true);
    // Sanity: the walk actually traversed (entry + worker modules + cli command).
    // The ceiling is a smell bound, not the guarantee â€” that is the FORBIDDEN_LOCAL /
    // FORBIDDEN_PACKAGES assertions below. Raised 25 â†’ 26 in #1038 for `cli/cli-path.ts`,
    // which imports only `node:path` and resolves CLI path arguments against INIT_CWD.
    // Raised 26 â†’ 27 in the arch loop (ak-1094) for `lib/worker-connect-steps.ts`: the
    // pattern-language spec forbids `server-route` (routes/workers.ts) importing
    // `server-cli` (cli/commands/worker.ts), so `buildWorkerConnectSteps` moved to pure
    // server-lib and this CLI module now imports it instead of defining it â€” one more
    // node in this graph, same pure shape (only the shared step-shape type).
    // Raised 27 â†’ 31 in #1338 for worker self-update: `worker/worker-updater.ts`,
    // `worker/worker-versions.ts`, `worker/worker-daemon-update.ts` and `lib/worker-update.ts`.
    // All four import only node builtins, `@agentic-kanban/shared/lib/*` and each other â€”
    // the FORBIDDEN_* assertions below are what guard the db-free property.
    // Raised 31 â†’ 34 in #1336 for `worker/agent-process-tree.ts`, `worker/worker-agent-registry.ts`
    // and `worker/worker-job-holder.ts` (node builtins, `process-exec` and the shared error helper).
    expect(files.size).toBeGreaterThan(3);
    // Raised 34 â†’ 36 in #1346 for `worker/worker-delegate.ts` and
    // `cli/commands/worker-doctor-build-check.ts` (node builtins + `worker-versions`).
    // Raised 36 â†’ 37 in #1350 for `worker/worker-shim.ts` (node builtins only).
    // Raised 37 â†’ 38 in #1326 for `cli/commands/worker-doctor-firewall-check.ts` (node builtins only).
    // Raised 38 â†’ 39 in #1355 for `worker/worker-control.ts` (node:http/fs/crypto + shared error-message).
    // Raised 39 â†’ 40 in #1358 for `cli/commands/worker-setup-guide.ts` (pure strings).
    // Raised 40 â†’ 41 in #1366 for `cli/commands/worker-board-build.ts` (fetch + worker-update helpers).
    // Raised 41 â†’ 44 in #1367 for `worker/worker-harness.ts`, `cli/commands/worker-doctor-harness.ts`
    // and `cli/commands/worker-auth-command.ts` (node builtins, commander, oauth-quota-core, shared error-message).
    // Raised 44 â†’ 47 in #1368 for `cli/commands/worker-setup.ts`, `worker-setup-installers.ts` and
    // `worker/worker-pair.ts` (node builtins, commander, and modules already in this graph).
    // Raised 47 -> 48 in #1369 for `cli/commands/worker-doctor-git-prereqs.ts` (git/identity/pnpm doctor checks plus
    // the package-manager probe the heartbeat reports; node builtins only). The probe is folded in, not a second file.
    // Raised 48 â†’ 49 in #1373 for `cli/commands/worker-update-notes.ts` (pure strings over modules already here).
    // Raised 49 -> 50 in #1376 for `worker/worker-socket-keepalive.ts` (ping/pong deadline; imports only `ws`).
    // Raised 50 -> 53 in #1372 for cli/commands/worker-board-default.ts, worker/worker-name.ts and
    // worker/worker-provider-notice.ts (node builtins and modules already here; the launcher helper lives in worker-update-notes).
    // Raised 53 -> 54 in #1374 for `worker/worker-path.ts` (WSL PATH policy + saved install dirs; node builtins only).
    // Raised 54 -> 55 in #1370 for `cli/commands/worker-doctor-daemon.ts` (the doctor-summary tracker; modules already here).
    // Raised 55 -> 56 in #1370 for `cli/commands/worker-pair-output.ts` (pair output split out of worker.ts for the
    // 1000-line ceiling; imports only modules already here).
    // Raised 56 -> 57 in #1379 for `worker/worker-profile-aliases.ts` (alias persistence in the state file; node builtins only).
    // Raised 57 -> 58 in #1402 for `worker/worker-repin.ts` (repins an old shim; node builtins + modules already here).
    // Raised 58 -> 59 in #1391 for `lib/session-temp-dir.ts` (per-session TMPDIR; imports shared temp-dir only).
    // Raised 59 -> 60 in #1383 for `worker/worker-git-token.ts` (asks the board for a fresh token after a 401; type-only imports).
    // Raised 60 -> 61 in #1417 for `worker/worker-repo-heal.ts` (corrupt-clone detection; git-exec + node:fs only).
    // Raised 61 -> 63 in #1381 for `worker/worker-settings-apply.ts` and shared `lib/worker-settings.ts` (board-pushed settings; node builtins only).
    // Raised 63 -> 64 in #1416 for the undelivered-results give-up/doctor helper module.
    // Raised 64 -> 65 in #1337 for `worker/worker-state.ts` (identity-keyed pairing state, db-free).
    // Raised 65 -> 66 in #1337 for `worker/worker-daemon-helpers.ts` (leaf helpers split out of the daemon).
    // Raised 66 -> 69 in #1371 for `worker/worker-toolchain-install.ts`, `cli/commands/worker-toolchain-command.ts`
    // and `cli/commands/worker-doctor-mise.ts` (node builtins + shared deep paths only).
    // Raised 69 -> 70 in #1431 for `worker/worker-oneshot.ts` (one-shot agent jobs; the shared protocol half is pure).
    // Raised 70 -> 71 in #1437 for `worker/worker-verify-runner.ts` and shared `lib/worker-verify-protocol.ts` (verify jobs on a worker; git-exec + node builtins only).
    // Raised 71 -> 73 in #1443 for `worker/worker-lifecycle.ts` and `cli/commands/worker-lifecycle-command.ts` (status/stop/restart/config; node builtins + sibling worker modules).
    // Raised 73 -> 74 in #1445 for `worker/worker-pending-delete.ts` (node builtins only).
    // Raised 74 -> 75 in #1444 for `cli/commands/worker-results-command.ts` (`results list|drop`; node builtins + git-exec only).
    // Raised 75 -> 76 in #1450 for `worker/worker-revoked-pairing.ts` (revoked-pairing probe; node builtins + worker-state only).
    // Raised 76 -> 77 in #1453 for `cli/commands/worker-doctor-running-daemon.ts` (the doctor's running-daemon check).
    // Raised 77 -> 78 in #1451 for `worker/worker-resources.ts` (free RAM/disk reading; node builtins + shared machine-capacity).
    // Raised 78 -> 79 in #1467 for `worker/worker-repo-skills.ts` (which skill names the repo tracks; git-exec only).
    // Raised 79 -> 80 in #1461: `worker/worker-lifecycle.ts` now reaches `worker/worker-undelivered.ts` (undelivered results in `status`).
    // Raised 80 -> 82 in #1472: `worker-result-idle.ts` and `worker-result-push.ts` were extracted from `createWorkerAgentRunner` (nloc ratchet).
    // Raised 82 -> 83 in #1474 for `worker/worker-repo-lock.ts` (per-repo clone/fetch serialization; node builtins only).
    // Raised 83 -> 84 in train 2026-10-14-49: #1483 added `cli/commands/worker-doctor-pnpm-version.ts` and #1488 added
    // shared `lib/git-spawn-governor.ts` (reached via git-exec); each fit alone, together they need one more slot.
    // Raised 84 -> 86 in train 2026-10-15-19: #1499 added `worker/worker-setup-slots.ts` (setup-concurrency
    // slots; node builtins only) and the train fix split process-exec's output parsers into a sibling module.
    // Raised 86 -> 87 in the 2026-10-16 hand flush for #1520's `worker/worker-content-index.ts` (marks the
    // worker data dirs not-content-indexed; node builtins + child_process only).
    // Raised 87 -> 88 for #1551's worker-startup-step.ts (restart-after-update connect step).
    expect(files.size).toBeLessThan(88);
  });

  it("never reaches the database or board-service layer", () => {
    const offenders = normalized.filter((f) =>
      FORBIDDEN_LOCAL.some((bad) => f.includes(bad.replace("src/", "/src/")) || f.includes(bad)),
    );
    expect(
      offenders,
      `The worker binary's import graph reached board-only modules:\n${offenders.join("\n")}\n` +
        "That re-introduces the DB/server load this binary exists to avoid â€” break the import.",
    ).toEqual([]);
  });

  it("depends only on npm packages a worker machine actually needs", () => {
    const bare = [...packages].filter((p) => !p.startsWith("@agentic-kanban/"));
    const leaked = bare.filter((p) => FORBIDDEN_PACKAGES.some((bad) => p === bad || p.startsWith(`${bad}/`)));
    expect(leaked, `Worker binary pulled in board-only packages: ${leaked.join(", ")}`).toEqual([]);
    // Whatever it does use must be a short, deliberate list.
    expect(bare.sort()).toEqual(["commander", "ws"]);
  });

  it("only uses shared subpaths that are dependency-free", () => {
    const sharedSpecs = [...packages].filter((p) => p.startsWith("@agentic-kanban/shared"));
    for (const spec of sharedSpecs) {
      // Deep paths only â€” the barrel re-exports the whole library surface.
      expect(spec, `worker code must import shared deep paths, not the barrel: ${spec}`)
        .toMatch(/^@agentic-kanban\/shared\/lib\//);
    }
    expect(sharedSpecs.length).toBeGreaterThan(0);
  });
});
