// @gate:always-run — scans every package's src tree for the client-port ladder; imports
// nothing it checks.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { walkPackageSources } from "../../../shared/__tests__/helpers/guard-scan.js";

/**
 * ONE board-client port ladder (#690, the sibling of #615's server-port guard).
 *
 * `process.env.KANBAN_CLIENT_PORT || process.env.VITE_PORT || "5173"` was copied verbatim
 * into the agent launch env, the review-agent prompt, and the post-merge verify-agent
 * prompt, while `shared/lib/board-server-url.ts` now exports `resolveBoardClientPort` for
 * exactly this. Zero-tolerance, with one named exception — the resolver itself.
 */
const packagesRoot = path.join(import.meta.dirname!, "..", "..", "..");
const repoRoot = path.join(packagesRoot, "..");
const SCAN_ROOTS = ["server/src", "shared/src", "mcp-server/src", "client/src"];

const LADDER = /\bKANBAN_CLIENT_PORT\b\s*\)?\s*(?:\|\||\?\?)/;

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const SANCTIONED: Record<string, string> = {
  "packages/shared/src/lib/board-server-url.ts": "the resolver itself",
  "packages/server/src/services/preflight-check.ts":
    "asks whether the operator SET a client port, so it must see the raw env — the resolver " +
    "always returns a number and would make the warning below it unreachable",
  "packages/server/src/routes/butler.ts":
    "falls back to the already-resolved server port (single-port production deployment), " +
    "not the resolver's hardcoded 5173 dev default",
};

const relFromRepo = (abs: string) => path.relative(repoRoot, abs).split(path.sep).join("/");

describe("board-client port ladder is single-source (#690)", () => {
  it("no file outside the sanctioned resolver hand-rolls the ladder", () => {
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of walkPackageSources(path.join(packagesRoot, root))) {
        const rel = relFromRepo(file);
        if (rel in SANCTIONED) continue;
        if (LADDER.test(stripComments(fs.readFileSync(file, "utf8")))) offenders.push(rel);
      }
    }
    expect(
      offenders,
      "use `resolveBoardClientPort()` from @agentic-kanban/shared/lib/board-server-url " +
        "(it takes an injectable `env`), or add a reason to SANCTIONED:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("every sanctioned exception still exists and still contains a ladder", () => {
    for (const [rel, reason] of Object.entries(SANCTIONED)) {
      const abs = path.join(repoRoot, rel);
      expect(fs.existsSync(abs), `${rel} is gone — drop it from SANCTIONED (${reason})`).toBe(true);
      expect(
        LADDER.test(stripComments(fs.readFileSync(abs, "utf8"))),
        `${rel} no longer hand-rolls a ladder — drop it from SANCTIONED (${reason})`,
      ).toBe(true);
    }
  });
});
