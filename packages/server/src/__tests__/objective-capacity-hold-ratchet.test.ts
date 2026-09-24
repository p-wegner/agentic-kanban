// @gate:always-run when:scripts/board-monitor/objective.md — reads scripts/board-monitor/objective.md, a repo file no source module imports (#1029).
/**
 * The Conductor's capacity brake is GENERATED, never hand-written (#1029).
 *
 * `scripts/board-monitor/objective.md` used to carry a hand-authored "MEMORY HOLD" paragraph
 * below the generated block: one afternoon's RAM reading pinned into policy, liftable only by a
 * human edit, while the in-process monitor already clamped to the measured headroom (#1019).
 * The generated block now renders a `## CAPACITY HOLD` section that points the Conductor at the
 * live `GET /api/projects/:id/monitor-tunables` → `capacity` verdict. This guard keeps the
 * objective on that footing: the generated section must be present, and no hand-written
 * capacity rule may come back beside it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const OBJECTIVE = join(import.meta.dirname, "..", "..", "..", "..", "scripts", "board-monitor", "objective.md");

describe("objective.md capacity brake is generated (#1029)", () => {
  const text = readFileSync(OBJECTIVE, "utf8");
  const start = text.indexOf("<!-- STRATEGY_BULLSEYE_GENERATED_START -->");
  const end = text.indexOf("<!-- STRATEGY_BULLSEYE_GENERATED_END -->");

  it("carries the generated CAPACITY HOLD section inside the Bullseye markers", () => {
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const generated = text.slice(start, end);
    expect(generated).toContain("## CAPACITY HOLD (generated - do not hand-edit)");
    expect(generated).toContain("/monitor-tunables");
    expect(generated).toContain("CAPACITY_HOLD =");
  });

  it("carries no hand-written MEMORY HOLD rule outside the generated block", () => {
    const handWritten = text.slice(0, start) + text.slice(end);
    expect(handWritten).not.toMatch(/MEMORY HOLD\s*\(/);
    expect(handWritten).not.toMatch(/start ZERO new builders/i);
  });
});
