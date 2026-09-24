// @gate:always-run when:packages/server/src/services/risk-posture.service.ts,docs/integration-risk-ladder.md
// — reads the ladder doc and the resolver's source off disk (neither is an import), so a diff to
// either selects nothing that reaches this suite (#1240).
/**
 * #1240 — the integration risk ladder (`docs/integration-risk-ladder.md`) is documented ONCE,
 * with the posture table in `risk-posture.service.ts` as its source of truth (decision 019).
 * This ratchet is what decision 019 promises: a posture level that exists in the resolver and
 * is missing from the doc's rungs table fails, and so does a rung the resolver does not have.
 *
 * Three sets are compared, not two: the level UNION (`RISK_POSTURES`, which every enumeration
 * in the code derives from) and the `case` labels of `postureForLevel` (the table itself) must
 * agree with each other as well as with the doc — a level added to the union but missing from
 * the switch silently resolves as `standard` through the `default` arm, which is exactly the
 * kind of drift that reads as "fine" until an operator picks it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RISK_POSTURES } from "@agentic-kanban/shared/lib/risk-posture";

const REPO_ROOT = resolve(import.meta.dirname!, "..", "..", "..", "..");
const LADDER_DOC = resolve(REPO_ROOT, "docs", "integration-risk-ladder.md");
const RESOLVER = resolve(REPO_ROOT, "packages", "server", "src", "services", "risk-posture.service.ts");

/**
 * The levels the rungs table names: every row of the FIRST table under `## The rungs` whose
 * first cell is `**<level>**`. Anything after the level in that cell (a ticket marker, a note)
 * is ignored, so `**flow** (#1240)` and `**flow**` both read as `flow`.
 */
export function rungLevelsFromDoc(markdown: string): string[] {
  const section = markdown.split(/^## The rungs\s*$/m)[1]?.split(/^## /m)[0] ?? "";
  const levels: string[] = [];
  for (const line of section.split(/\r?\n/)) {
    const m = /^\|\s*\*\*([a-z][a-z-]*)\*\*/.exec(line);
    if (m) levels.push(m[1]);
  }
  return levels;
}

/** The `case "<level>":` labels of the resolver's one `switch` — the posture table's rows. */
export function caseLevelsFromResolver(source: string): string[] {
  return [...source.matchAll(/^\s*case "([a-z][a-z-]*)":/gm)].map((m) => m[1]);
}

const sorted = (xs: readonly string[]) => [...new Set(xs)].sort();

describe("the risk ladder doc and the posture resolver name the same levels (#1240)", () => {
  it("every level in the resolver has a rung, and every rung is a level", () => {
    const doc = sorted(rungLevelsFromDoc(readFileSync(LADDER_DOC, "utf8")));
    const union = sorted(RISK_POSTURES);
    const cases = sorted(caseLevelsFromResolver(readFileSync(RESOLVER, "utf8")));

    expect(doc.length, "the rungs table in docs/integration-risk-ladder.md was not found or is empty").toBeGreaterThan(0);
    expect(
      doc,
      `docs/integration-risk-ladder.md's rungs table and RISK_POSTURES disagree — add the missing row (or drop the ` +
        `stale one) so the ladder stays the one place the levels are explained (decision 019)`,
    ).toEqual(union);
    expect(
      cases,
      `postureForLevel's case labels and RISK_POSTURES disagree — a level with no case resolves as 'standard' ` +
        `through the default arm, invisibly`,
    ).toEqual(union);
  });

  it("the parser sees a level's row with or without a trailing marker, and only inside the rungs table", () => {
    const fixture = [
      "# The ladder",
      "",
      "## The rungs",
      "",
      "| Rung | Merge proves |",
      "|---|---|",
      "| **strict** | everything |",
      "| **flow** (#1240) | typecheck + selection |",
      "| plain text row | not a rung |",
      "",
      "## Where each piece lives",
      "",
      "| **iterate** | this is a different table and must not count |",
      "",
    ].join("\n");
    expect(rungLevelsFromDoc(fixture)).toEqual(["strict", "flow"]);
  });

  it("a fixture doc missing a level fails the same comparison the real doc is held to", () => {
    const fixture = "## The rungs\n\n| Rung |\n|---|\n" + RISK_POSTURES.filter((l) => l !== "flow").map((l) => `| **${l}** |`).join("\n") + "\n";
    expect(sorted(rungLevelsFromDoc(fixture))).not.toEqual(sorted(RISK_POSTURES));
  });

  it("the resolver parser reads the switch's case labels", () => {
    const fixture = 'switch (level) {\n    case "strict":\n      return x;\n    case "flow":\n      return y;\n    case "standard":\n    default:\n      return z;\n  }';
    expect(caseLevelsFromResolver(fixture)).toEqual(["strict", "flow", "standard"]);
  });
});
