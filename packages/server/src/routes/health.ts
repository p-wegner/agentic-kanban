import { createRouter } from "../middleware/create-router.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkHealthDeps } from "../services/health-deps.service.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const defaultRepoRoot = resolve(__dirname, "../../../../");

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
      { status: deps.ok ? "ok" : "degraded", ok: deps.ok, checks: deps.checks },
      deps.ok ? 200 : 503,
    );
  });

  router.get("/deps", (c) => {
    const result = checkHealthDeps(repoRoot);
    return c.json(result, result.ok ? 200 : 503);
  });

  return router;
}
