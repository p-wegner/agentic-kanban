import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface DepCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface HealthDepsResult {
  ok: boolean;
  checks: DepCheck[];
}

export function checkHealthDeps(repoRoot: string): HealthDepsResult {
  const serverRoot = resolve(repoRoot, "packages/server");
  const checks: DepCheck[] = [
    checkDrizzleJournal(repoRoot),
    checkNodeModule(serverRoot, "drizzle-orm"),
    checkNodeModule(serverRoot, "hono"),
    checkSharedDist(repoRoot),
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
