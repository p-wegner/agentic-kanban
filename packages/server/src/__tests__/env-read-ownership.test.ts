// @gate:always-run — walks every package's src tree and reads `docs/env-vars.md`; it
// imports none of the files it judges.
/**
 * Every `process.env` read has a known OWNER (#707).
 *
 * #615 turned seven renamed variables into data (`KANBAN_ENV`) and pinned them against
 * `docs/env-vars.md`. But that pairing was a closed loop over those seven: the parity test
 * asks "is every REGISTERED var documented", which nothing outside the registry can fail.
 * Meanwhile 84 bare `process.env.<NAME>` reads across 42 distinct names sat outside it —
 * 21 of them `KANBAN_*`, i.e. board-owned by the page's own naming rule and documented
 * nowhere — and no rule forbade an 85th. The doc said as much in a caveat.
 *
 * This is the rule that replaces the caveat, and it is an ownership question rather than a
 * documentation one, because "who does this variable belong to?" is what an unprefixed name
 * in an agent's spawn env genuinely cannot answer:
 *
 *   - **board-owned** (`KANBAN_*`, `AGENTIC_KANBAN_*`) — must have a row in
 *     `docs/env-vars.md`. Zero tolerance: the page is the inventory, so a board var missing
 *     from it is the exact defect #707 describes.
 *   - **foreign** (the OS, Node, an agent CLI, a build tool) — must be declared in `FOREIGN`
 *     below with a note on whose it is. Not documented as ours, but not anonymous either.
 *
 * Deliberately NOT a grandfathered baseline of shame. A frozen "these 10 are undocumented"
 * set is a budget: it goes green while the debt sits there, and the next reader cannot tell
 * a deliberate exemption from an unpaid one. Both categories here are answerable today, so
 * the gate asks for the answer.
 *
 * Scope is every package's `src` tree, excluding tests: a suite setting `process.env.KANBAN_TEST_*` to
 * drive its own fixture is not making a claim about the product's configuration surface.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { walkPackageSources } from "../../../shared/__tests__/helpers/guard-scan.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const packagesRoot = path.join(repoRoot, "packages");
const PACKAGES = ["shared", "server", "client", "mcp-server"];

/** `process.env.FOO` and `process.env["FOO"]`. */
const ENV_READ = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)|process\.env\[\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*\]/g;

const BOARD_PREFIXES = ["KANBAN_", "AGENTIC_KANBAN_"];

/**
 * Variables the board READS but does not own, each with whose they are. A name here is a
 * claim that renaming it is not ours to do — which is the same argument `docs/env-vars.md`
 * makes for the scaffold guards' variables, written where a test can check it.
 *
 * Only what is ACTUALLY read as `process.env.<NAME>` under a package's `src`, which the
 * stale-entry test below enforces. It is therefore shorter than the "third-party and OS"
 * bullet on the doc page, and deliberately so: `ANTHROPIC_*`, `CODEX_HOME` and friends reach
 * an agent through a spawn-env OBJECT built by `buildSpawnEnv`, never through a direct read
 * here, and listing them would be a claim this suite cannot check.
 */
const FOREIGN: Record<string, string> = {
  // OS / shell
  PATH: "OS — executable search path, used to resolve an agent CLI",
  PATHEXT: "Windows — the extensions that make a file executable (.EXE/.CMD/.BAT/.PS1)",
  APPDATA: "Windows — roaming app data, where a global npm install puts its bin",
  LOCALAPPDATA: "Windows — local app data, a candidate Node install location",
  ProgramFiles: "Windows — a candidate Node install location",
  // Node runtime
  UV_THREADPOOL_SIZE: "libuv — the board raises it when unset; documented under Runtime tuning",
  // Agent CLIs: their config roots. Renaming any of these would break the CLI, not us.
  CLAUDE_CONFIG_DIR: "Claude Code — its config root; the board reads it to find session state",
  PI_CODING_AGENT_DIR: "Pi — its config/credential root",
  // Ports the ecosystem already names. Renaming them would break every convention that sets them.
  PORT: "hosting convention — the server port when no KANBAN_* port is set",
  VITE_PORT: "Vite convention",
  SERVER_PORT: "pre-KANBAN_ port name, still honoured; see docs/env-vars.md",
  DB_URL: "the #615 legacy alias of KANBAN_DB_URL, read through readBoardEnv",
};

interface Read {
  name: string;
  file: string;
}

function scanReads(): Read[] {
  const reads: Read[] = [];
  for (const pkg of PACKAGES) {
    for (const file of walkPackageSources(path.join(packagesRoot, pkg, "src"))) {
      const source = fs.readFileSync(file, "utf-8");
      for (const m of source.matchAll(ENV_READ)) {
        reads.push({
          name: (m[1] ?? m[2])!,
          file: path.relative(packagesRoot, file).replace(/\\/g, "/"),
        });
      }
    }
  }
  return reads;
}

const isBoardOwned = (name: string) => BOARD_PREFIXES.some((p) => name.startsWith(p));

describe("every process.env read has a known owner (#707)", () => {
  const reads = scanReads();
  const doc = fs.readFileSync(path.join(repoRoot, "docs", "env-vars.md"), "utf8");

  it("finds env reads at all — a rule over an empty set guards nothing", () => {
    expect(reads.length).toBeGreaterThan(30);
  });

  it("every board-owned variable has a row in docs/env-vars.md", () => {
    const undocumented = [
      ...new Set(reads.filter((r) => isBoardOwned(r.name) && !doc.includes(`\`${r.name}\``)).map((r) => r.name)),
    ].sort();

    expect(
      undocumented,
      [
        "These are board-owned by the naming rule but have no row on the page that claims to",
        "be the inventory. Add one — the purpose, and the default if it has one.",
        "",
        ...undocumented.map((n) => `  ${n}  (${reads.filter((r) => r.name === n)[0]!.file})`),
      ].join("\n"),
    ).toEqual([]);
  });

  it("every foreign variable is declared with whose it is", () => {
    const undeclared = [...new Set(reads.filter((r) => !isBoardOwned(r.name) && !(r.name in FOREIGN)).map((r) => r.name))].sort();

    expect(
      undeclared,
      [
        "An unprefixed `process.env` read whose owner nobody has stated. Either:",
        "  - it is ours -> rename it `KANBAN_<NAME>` and give it a row in docs/env-vars.md,",
        "  - or it is not -> add it to FOREIGN with a note on whose it is.",
        "The point is that an unprefixed name in an agent's spawn env is ambiguous about",
        "ownership, which is exactly what #615 set out to fix and #707 finishes.",
        "",
        ...undeclared.map((n) => `  ${n}  (${reads.filter((r) => r.name === n)[0]!.file})`),
      ].join("\n"),
    ).toEqual([]);
  });

  it("has no stale FOREIGN entry — a dead exemption excuses the next name that lands on it", () => {
    const live = new Set(reads.map((r) => r.name));
    const stale = Object.keys(FOREIGN).filter((n) => !live.has(n)).sort();
    expect(
      stale,
      `FOREIGN declares variables the tree no longer reads — delete them:\n  ${stale.join("\n  ")}`,
    ).toEqual([]);
  });

  it("no FOREIGN entry claims a board-prefixed name", () => {
    // `KANBAN_FOO` in FOREIGN would exempt one of our own variables from documentation,
    // which is the one way this guard could be turned against its own purpose.
    expect(Object.keys(FOREIGN).filter(isBoardOwned)).toEqual([]);
  });

  it("every FOREIGN note actually says something about ownership", () => {
    const empty = Object.entries(FOREIGN)
      .filter(([, why]) => why.trim().length < 10)
      .map(([n]) => n);
    expect(empty, "a FOREIGN note must name the owner, not just exist").toEqual([]);
  });
});
