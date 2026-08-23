// @gate:always-run — scans every package's src tree and reads the dev proxy (a .mjs outside
// src); imports nothing it checks except the two resolvers it compares.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { walkPackageSources } from "../../../shared/__tests__/helpers/guard-scan.js";
import { resolvePublicBoardUrl } from "../runtime-port.js";
// @ts-expect-error — `scripts/` is plain .mjs with no type declarations and is not part
// of any package tsconfig, so this import is implicitly `any`. Suppressed rather than
// typed because the suite's whole point is to read the REAL script the runner uses; a
// hand-written .d.ts beside it would be one more thing that can drift from it.
import { resolvePublicServerPort } from "../../../../scripts/server-dev-proxy.mjs";

/**
 * ONE board-server port ladder (#615).
 *
 * `process.env.KANBAN_SERVER_PORT || process.env.PORT || "3001"` was copied ten times
 * across routes, services and startup while `shared/lib/board-server-url.ts` already
 * exported `resolveBoardServerPort` — a helper landed, the ring never drained. The cost is
 * not the duplication: it is that a rung added to the shared resolver later
 * (`KANBAN_BOARD_SERVER_PORT`, which is exactly how a worktree names the MAIN board)
 * reached some call sites and not others, so the same env produced different ports
 * depending on which copy ran.
 *
 * Zero-tolerance, with three NAMED exceptions — each is a ladder rather than a caller.
 */
const packagesRoot = path.join(import.meta.dirname!, "..", "..", "..");
const repoRoot = path.join(packagesRoot, "..");
const SCAN_ROOTS = ["server/src", "shared/src", "mcp-server/src", "client/src"];

/**
 * A hand-rolled ladder: an env port read fed into a fallback, in either spelling — `||`
 * (the `process.env` copies) or `??` (the `parsePort(...) ??` chains).
 */
const LADDER = /\bKANBAN_SERVER_PORT\b\s*\)?\s*(?:\|\||\?\?)/;

/**
 * A SHORTER hand-rolled ladder that skips `KANBAN_SERVER_PORT` entirely — `process.env.PORT`
 * fed straight into the board's own `3001` default. This is the shape the original guard's
 * regex could not see (#690): `cli/index.ts`, `cli/commands/system.ts` and `server-start.ts`
 * each spelled `process.env.PORT || 3001` (or the `??`/pre-set-then-read variant), honouring
 * NONE of the ladder's rungs, and the KANBAN_SERVER_PORT-anchored regex above never fired on
 * any of them.
 */
const BARE_PORT_LADDER = /\bprocess\.env\.PORT\b[^;\n]*3001/;

/**
 * Comments are stripped before scanning. Without this the guard flags the DOCUMENTATION of
 * its own rule — the resolver's header quotes the ladder it replaced, and so does the
 * comment left at each drained call site. A guard that fires on prose about itself teaches
 * people to delete the prose.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Repo-relative paths, forward slashes, each with the reason it may spell the ladder out. */
const SANCTIONED: Record<string, string> = {
  "packages/shared/src/lib/board-server-url.ts": "the resolver itself",
  "packages/server/src/runtime-port.ts":
    "the runtime/public split — the backend BINDS the internal port in dev while the proxy " +
    "owns the public one, so it cannot delegate to the board resolver without naming the wrong port",
  "packages/server/src/services/preflight-check.ts":
    "asks whether the operator SET a port, so it must see the raw env — the resolver always " +
    "returns a number and would make the warning below it unreachable",
};

const relFromRepo = (abs: string) => path.relative(repoRoot, abs).split(path.sep).join("/");

describe("board-server port ladder is single-source (#615)", () => {
  it("no file outside the sanctioned resolvers hand-rolls the ladder", () => {
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of walkPackageSources(path.join(packagesRoot, root))) {
        const rel = relFromRepo(file);
        if (rel in SANCTIONED) continue;
        const text = stripComments(fs.readFileSync(file, "utf8"));
        if (LADDER.test(text) || BARE_PORT_LADDER.test(text)) offenders.push(rel);
      }
    }
    expect(
      offenders,
      "use `resolveBoardServerPort()` from @agentic-kanban/shared/lib/board-server-url " +
        "(it takes an injectable `env`), or add a reason to SANCTIONED:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("every sanctioned exception still exists and still contains a ladder", () => {
    // Without this the allow-list outlives the code it excuses, and the next hand-rolled
    // ladder inherits a free pass from a path that no longer means anything.
    for (const [rel, reason] of Object.entries(SANCTIONED)) {
      const abs = path.join(repoRoot, rel);
      expect(fs.existsSync(abs), `${rel} is gone — drop it from SANCTIONED (${reason})`).toBe(true);
      expect(
        LADDER.test(stripComments(fs.readFileSync(abs, "utf8"))),
        `${rel} no longer hand-rolls a ladder — drop it from SANCTIONED (${reason})`,
      ).toBe(true);
    }
  });

  /**
   * `runtime-port.ts` says in prose that its public chain "mirrors the proxy's own
   * `resolvePublicServerPort`". Two copies of a chain linked by a COMMENT is the same
   * failure one level up, and it matters: the proxy owns the public port in dev, so a
   * divergence hands out a URL nothing is listening on.
   */
  it("resolvePublicBoardUrl agrees with the dev proxy's chain on every rung", () => {
    const cases: Array<Record<string, string | undefined>> = [
      {},
      { PORT: "4000" },
      { SERVER_PORT: "4100", PORT: "4000" },
      { KANBAN_SERVER_PORT: "4200", SERVER_PORT: "4100", PORT: "4000" },
      { KANBAN_WORKTREE_SERVER_PORT: "4300", KANBAN_SERVER_PORT: "4200", SERVER_PORT: "4100", PORT: "4000" },
      // The internal port must be INVISIBLE to both: it is what the backend binds behind
      // the proxy, and a public URL naming it dies on every tsx-watch restart.
      { KANBAN_INTERNAL_SERVER_PORT: "13001", KANBAN_SERVER_PORT: "4200" },
      // Junk must fall through identically rather than one side coercing it.
      { KANBAN_SERVER_PORT: "not-a-port", PORT: "4000" },
    ];
    for (const env of cases) {
      const viaProxy = resolvePublicServerPort(env);
      expect(
        resolvePublicBoardUrl(env as NodeJS.ProcessEnv),
        `chain diverged from scripts/server-dev-proxy.mjs for ${JSON.stringify(env)}`,
      ).toBe(`http://localhost:${viaProxy}`);
    }
  });
});
