import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface DepCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface HealthDepsResult {
  ok: boolean;
  checks: DepCheck[];
}

// This file is inlined into dist/server.js (__dirname = <app>/dist) and
// dist/cli/index.js (__dirname = <app>/dist/cli) by the esbuild bundle; in a dev
// checkout it runs from src/services. Running from dist/ is the bundle signal.
const BUNDLED_APP_ROOT = /[\\/]dist$/.test(__dirname)
  ? resolve(__dirname, "..")
  : /[\\/]dist[\\/]cli$/.test(__dirname)
    ? resolve(__dirname, "../..")
    : null;

export function checkHealthDeps(repoRoot: string): HealthDepsResult {
  // Bundled install (npm package, Docker image): there is no workspace layout —
  // the equivalent liveness facts are the migration journal copied into
  // dist/migrations and the external runtime deps installed next to dist/.
  if (BUNDLED_APP_ROOT) {
    return checkBundledDeps(BUNDLED_APP_ROOT);
  }
  const serverRoot = resolve(repoRoot, "packages/server");
  const checks: DepCheck[] = [
    checkDrizzleJournal(repoRoot),
    checkNodeModule(serverRoot, "drizzle-orm"),
    checkNodeModule(serverRoot, "hono"),
    checkSharedDist(repoRoot),
  ];
  return { ok: checks.every((c) => c.ok), checks };
}

/** Health checks for a bundled runtime (appRoot = the directory containing dist/). */
function checkBundledDeps(appRoot: string): HealthDepsResult {
  const journalPath = resolve(appRoot, "dist", "migrations", "meta", "_journal.json");
  const journalOk = existsSync(journalPath);
  const checks: DepCheck[] = [
    {
      name: "migrations-journal",
      ok: journalOk,
      detail: journalOk ? journalPath : `Missing: ${journalPath} — reinstall the package`,
    },
    checkNodeModule(appRoot, "drizzle-orm"),
    checkNodeModule(appRoot, "hono"),
  ];
  return { ok: checks.every((c) => c.ok), checks };
}

function checkDrizzleJournal(repoRoot: string): DepCheck {
  const journalPath = resolve(repoRoot, "packages/shared/drizzle/meta/_journal.json");
  const ok = existsSync(journalPath);
  return {
    name: "drizzle-journal",
    ok,
    detail: ok
      ? journalPath
      : `Missing: ${journalPath} — restore with: git restore packages/shared/drizzle/meta/_journal.json`,
  };
}

function checkNodeModule(repoRoot: string, moduleName: string): DepCheck {
  const modulePath = resolve(repoRoot, "node_modules", moduleName);
  const ok = existsSync(modulePath);
  return {
    name: `node_modules/${moduleName}`,
    ok,
    detail: ok ? modulePath : `Missing: ${modulePath} — restore with: pnpm install`,
  };
}

function checkSharedDist(repoRoot: string): DepCheck {
  const distPath = resolve(repoRoot, "packages/shared/dist/index.js");
  const ok = existsSync(distPath);
  return {
    name: "shared-dist",
    ok,
    detail: ok
      ? distPath
      : `Missing: ${distPath} — restore with: pnpm --filter @agentic-kanban/shared build`,
  };
}
