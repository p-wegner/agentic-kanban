/**
 * #1051: `verify_max_workers` governed one of the verify script's three steps.
 *
 * The project's verify script here is `pnpm check:arch && pnpm typecheck && pnpm test:mine`.
 * The gate capped vitest's fan-out via `KANBAN_TEST_MAX_WORKERS` and passed nothing to the
 * other two — so the typecheck step (five `tsc` runs at 0.5-1 GB peak each) ran at whatever
 * `scripts/typecheck.mjs` chose for itself, and depcruise (1834 modules, one process) had no
 * knob at all. Measured 2026-09-05/06: this host sat at 2-3 GB usable with 11.5 GB in a leaked
 * kernel pool, and the verify child kept dying mid-step.
 *
 * These pin the CLAMP, which is the part that is easy to get wrong in the flattering
 * direction: a tsc worker is not a vitest worker, so the budget is `min(workers, 2)` rather
 * than a mirror of the test fan-out.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_VERIFY_MAX_WORKERS } from "../services/verify-tunables.js";
import { buildVerifyResourceEnv } from "../services/verify-resource-env.js";

/** The clamp as the gate applies it (`pre-merge-gate.service.ts`'s `isolationEnv`). */
const typecheckWorkersFor = (gateMaxWorkers: number) =>
  Number(buildVerifyResourceEnv(gateMaxWorkers).KANBAN_TYPECHECK_WORKERS);

describe("gate typecheck worker budget (#1051)", () => {
  it("never exceeds the documented ceiling, however many test workers are asked for", () => {
    // 4 tsc workers is ~4 GB of peak; the ceiling is what stops a generous test setting
    // becoming a memory decision nobody made.
    expect(typecheckWorkersFor(8)).toBe(2);
    expect(typecheckWorkersFor(4)).toBe(2);
  });

  it("follows a project DOWN, which is the point on a tight host", () => {
    expect(typecheckWorkersFor(1)).toBe(1);
  });

  it("matches what the script picks unaided at the default, so this changes who decides and not the value", () => {
    // `scripts/typecheck.mjs` uses `Number(env) || 2`. Landing this must not silently change
    // the current behaviour of any project already on the default.
    expect(typecheckWorkersFor(DEFAULT_VERIFY_MAX_WORKERS)).toBe(2);
  });

  it("is a positive integer for every worker count a project can set", () => {
    for (const w of [1, 2, 3, 4, 6, 8, 16]) {
      const v = typecheckWorkersFor(w);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(1);
    }
  });
});
