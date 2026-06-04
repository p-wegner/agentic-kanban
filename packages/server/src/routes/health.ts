import { createRouter } from "../middleware/create-router.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkHealthDeps } from "../services/health-deps.service.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "../../../../");

export function createHealthRoute() {
  const router = createRouter();

  router.get("/deps", (c) => {
    const result = checkHealthDeps(repoRoot);
    return c.json(result, result.ok ? 200 : 503);
  });

  return router;
}
