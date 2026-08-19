import { createRouter } from "../middleware/create-router.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkHealthDeps } from "../services/health-deps.service.js";
import { DB_LOCATION } from "../db/data-dir.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const defaultRepoRoot = resolve(__dirname, "../../../../");

/**
 * WHICH database this process opened, reported on the liveness probe. "The board is
 * empty" has exactly one interesting cause — the server resolved a different DB than
 * the operator thinks (#663) — and before this it took a manual sqlite probe to find
 * out. `rejectedLocalCandidates` is the other half: an in-checkout file that exists but
 * was NOT adopted is the fingerprint of a stray shadowing the real board.
 */
function describeDb() {
  return {
    path: DB_LOCATION.path,
    source: DB_LOCATION.source,
    rejectedLocalCandidates: DB_LOCATION.rejectedLocalCandidates,
  };
}

export function createHealthRoute(repoRoot: string = defaultRepoRoot) {
  const router = createRouter();

  // Dependency-aware health. Unlike a bare liveness probe, this returns 503
  // when a critical dependency is missing — most importantly the shared
  // package's compiled dist. After a shared-dist loss (#691) the process is
  // still listening, so a naive "status: ok" probe stays green while every
  // DB-backed API route fails with ERR_MODULE_NOT_FOUND. Reporting "degraded"
  // here lets monitors detect a board that is up but unusable.
  router.get("/", (c) => {
    const deps = checkHealthDeps(repoRoot);
    return c.json(
      { status: deps.ok ? "ok" : "degraded", ok: deps.ok, checks: deps.checks, db: describeDb() },
      deps.ok ? 200 : 503,
    );
  });

  router.get("/deps", (c) => {
    const result = checkHealthDeps(repoRoot);
    return c.json(result, result.ok ? 200 : 503);
  });

  return router;
}
