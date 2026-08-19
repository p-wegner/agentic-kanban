// @gate:always-run — scans the server source tree by path; imports nothing it checks.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { walkPackageSources } from "../../../shared/__tests__/helpers/guard-scan.js";

/**
 * `services/` must not import UP into `startup/` (#594).
 *
 * These were the only runtime rule violations left in the pattern spec once type-only
 * imports were erased — five of them, all services reaching up. Direction is the point, not
 * tidiness: `startup/` composes and drives `services/`, so an upward edge means the two can
 * only ever be loaded together, and one case (`autodrive-stall-warning` →
 * `monitor-cycle-rules`, which itself imports two services) was already a startup↔service
 * CYCLE.
 *
 * Four were fixed by relocating pure utilities. The last needed a real extraction:
 * `plugin-loop-start.service` wanted ~40 lines of WIP counting and had to import a 579-line
 * orchestrator to get them, so those lines became `services/wip-capacity.service.ts`.
 *
 * Zero-tolerance. `pattern_edges.py` measures this too, but nothing runs it in CI — which is
 * how five violations accumulated in a three-month-old repo.
 */
const serverSrc = path.join(import.meta.dirname!, "..");

/**
 * A RUNTIME import of `startup/` from `services/`.
 *
 * `[^;]*?` rather than `[\s\S]*?` is load-bearing: a lazy any-char body lets the engine
 * BACKTRACK across statement boundaries, so a `import type { X } from "../startup/…"` line
 * gets matched together with some earlier non-type `import` above it and reported as a
 * runtime edge. Refusing to cross a `;` keeps each match inside one statement. (Found by
 * writing this guard and watching it flag a type-only import.)
 *
 * Type-only imports are erased at compile time and create no dependency, so they are not
 * edges — the spec's own measurement makes the same distinction.
 */
const UPWARD_IMPORT = /import\s+([^;]*?)\s*from\s*["']((?:\.\.\/)+startup\/[^"']*)["']/g;

function upwardRuntimeImports(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  const hits: string[] = [];
  for (const match of text.matchAll(UPWARD_IMPORT)) {
    const clause = match[1].trim();
    if (clause.startsWith("type ")) continue;
    const inner = clause.replace(/^\{|\}$/g, "").trim();
    // `import { type A, type B } from …` is erased exactly like `import type`.
    if (inner && inner.split(",").every((part) => !part.trim() || part.trim().startsWith("type "))) continue;
    hits.push(`${clause} from "${match[2]}"`);
  }
  return hits;
}

describe("service layer direction (#594)", () => {
  it("no file under services/ imports startup/ at runtime", () => {
    const offenders: string[] = [];
    for (const file of walkPackageSources(path.join(serverSrc, "services"))) {
      for (const hit of upwardRuntimeImports(file)) {
        offenders.push(`${path.relative(serverSrc, file).split(path.sep).join("/")}: ${hit}`);
      }
    }
    expect(
      offenders,
      "services/ must not reach up into startup/. Relocate the utility into services/ or " +
        "lib/, or extract what the service actually needs:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("the scan reaches the services tree at all", () => {
    // A path typo would make the assertion above vacuously green forever.
    expect(walkPackageSources(path.join(serverSrc, "services")).length).toBeGreaterThan(100);
  });
});
