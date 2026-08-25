// The build version of the `agentic-kanban` package THIS code runs from (#879/#880).
//
// On the board process it is the board's own build — the reference each worker's reported
// `workerVersion` is compared against. In the standalone worker binary it is the worker's
// installed build — the same value `--version` and the daemon's `resolveWorkerVersion()`
// report. Same lookup in both cases: walk up from this module's own file to the nearest
// `package.json` named `agentic-kanban`, which works from `src/` under tsx, from the tsc
// output under `dist/`, and from the esbuild worker bundle. Never fabricated — an
// unresolvable version is `undefined`, which renders as `?` everywhere, per the
// registry's "we assumed" vs "it said" rule.
//
// Deliberately db-free: this module is reachable from the standalone worker binary
// (`worker update-check`), which must never pull in the database graph
// (docs/worker-fleet.md §3).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveOwnPackageVersion(moduleUrl: string = import.meta.url): string | undefined {
  try {
    let dir = dirname(fileURLToPath(moduleUrl));
    for (let up = 0; up < 6; up++) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === "agentic-kanban" && pkg.version) return pkg.version;
      } catch {
        /* no manifest at this level */
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* fall through */
  }
  return undefined;
}
