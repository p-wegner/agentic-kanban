import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Architecture guard for ticket #901 / #890-A1: "Route ALL provider/profile
// resolution through one shared resolver."
//
// `resolveEffectiveProviderProfile` / `resolveEffectiveModel`
// (services/effective-config.service.ts) are the single source of truth for
// turning the preference map into a `{provider, profileName, model}` decision.
// Before this gate, the butler route hand-rolled its own butler>Bullseye>settings
// cascade (routes/butler.ts) that silently narrowed to claude|codex so copilot/pi
// were impossible. That fork is deleted — the route now mirrors the Bullseye onto the
// prefMap and calls the shared resolver. This test makes "one resolver" MACHINE-TRUE
// so a regression fails `pnpm test` instead of eroding silently. Same shape as
// no-self-http-in-services.test.ts.
//
// #984 closed the mcp-server exemption: the cross-package seam now exists —
// `resolveProviderProfileFromPrefs` in `@agentic-kanban/shared/lib/strategy-policy`
// is the pure, client-safe Bullseye-aware selection core (Bullseye policies →
// settings `provider` + `<provider>_profile` fallback). The mcp-server
// start_workspace tool calls it instead of hand-rolling a codex→claude profile
// ladder, so this gate also scans mcp-server/src: no hand-rolled
// `prefMap.get("<provider>_profile")` reads may reappear there.
//
// The lock: `selectProviderFromStrategy()` reads the raw Strategy Bullseye and is the
// PRIMITIVE a hand-rolled resolution fork reaches for. Launch-time provider/profile
// resolution must NOT call it directly — it must funnel through the shared resolver
// (which mirrors the Bullseye onto the prefMap via `applyProviderSelectionToPrefMap`
// first). Only a small, explicit allow-list of files may call it: the strategy module
// that defines it, and the legitimate Bullseye *readers* (divergence detection, the
// route that mirrors it onto the prefMap before calling the resolver). Drive preflight
// migrated to the shared cross-package resolver (`resolveProviderProfileFromPrefs`,
// #992) and was removed from this allow-list. Any NEW caller is a likely fork and
// fails here until it is justified + added below.

const SERVER_SRC = join(import.meta.dirname, "..");
const MCP_SERVER_SRC = join(import.meta.dirname, "..", "..", "..", "mcp-server", "src");

// Files permitted to reference `selectProviderFromStrategy`. Each is a deliberate
// Bullseye reader, NOT a launch-time resolution fork — shrink/justify before adding.
const SELECT_PROVIDER_ALLOWLIST = new Set<string>([
  // defines the function
  "services/strategy-objective.service.ts",
  // divergence detector: compares Bullseye vs settings (read-only diagnostic)
  "services/project-runtime-config.service.ts",
  // preflight: reports the would-be provider before a drive starts
  "services/drive-preflight.service.ts",
  // butler route: mirrors the Bullseye onto the prefMap, THEN calls the shared
  // resolver — it does not narrow or decide provider itself.
  "routes/butler.ts",
]);

/** Recursively collect non-test .ts source files under a directory. */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !full.includes("__tests__")) {
      out.push(full);
    }
  }
  return out;
}

/** Strip // line and block comments so a comment mentioning the symbol is not flagged. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** The repo-relative path under packages/<pkg>/src, with forward slashes. */
function relUnder(file: string, root: string): string {
  return file.slice(root.length + 1).replace(/\\/g, "/");
}

describe("architecture: provider/profile resolution funnels through one shared resolver (#901)", () => {
  const serverFiles = collectSourceFiles(SERVER_SRC);

  it("finds server source files to scan", () => {
    expect(serverFiles.length).toBeGreaterThan(50);
  });

  it("the shared resolver exists and is exported", () => {
    const resolver = readFileSync(join(SERVER_SRC, "services", "effective-config.service.ts"), "utf8");
    expect(resolver).toMatch(/export function resolveEffectiveProviderProfile/);
    expect(resolver).toMatch(/export function resolveEffectiveModel/);
  });

  it("selectProviderFromStrategy is only called from the allow-listed Bullseye readers", () => {
    const offenders: string[] = [];
    for (const file of serverFiles) {
      const rel = relUnder(file, SERVER_SRC);
      if (SELECT_PROVIDER_ALLOWLIST.has(rel)) continue;
      const code = stripComments(readFileSync(file, "utf8"));
      if (/\bselectProviderFromStrategy\b/.test(code)) {
        offenders.push(rel);
      }
    }
    expect(
      offenders,
      "selectProviderFromStrategy() found outside the allow-list — do NOT re-derive the " +
        "provider from the Bullseye here. Mirror it onto the prefMap with " +
        "applyProviderSelectionToPrefMap() and call resolveEffectiveProviderProfile() " +
        "instead (the shared resolver). Offending files:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  describe("mcp-server (#984 — exemption closed)", () => {
    const mcpFiles = collectSourceFiles(MCP_SERVER_SRC);

    it("finds mcp-server source files to scan", () => {
      expect(mcpFiles.length).toBeGreaterThan(20);
    });

    it("no mcp tool hand-rolls provider/profile resolution from raw *_profile pref reads", () => {
      // The hand-rolled fork this gate kills: reading a provider's profile via a
      // literal `prefMap.get("claude_profile")`-style ladder (which ignored the
      // Strategy Bullseye and fell copilot/pi through to claude_profile). All
      // launch-default resolution must go through the shared
      // resolveProviderProfileFromPrefs (strategy-policy.ts).
      const handRolled = /\.get\(\s*["'](?:claude|codex|copilot|pi)_profile["']\s*\)/;
      const offenders: string[] = [];
      for (const file of mcpFiles) {
        const code = stripComments(readFileSync(file, "utf8"));
        if (handRolled.test(code)) {
          offenders.push(relUnder(file, MCP_SERVER_SRC));
        }
      }
      expect(
        offenders,
        "hand-rolled `<provider>_profile` pref read found in mcp-server — resolve " +
          "provider+profile via resolveProviderProfileFromPrefs() from " +
          "@agentic-kanban/shared/lib/strategy-policy instead. Offending files:\n" +
          offenders.join("\n"),
      ).toEqual([]);
    });

    it("start_workspace resolves provider/profile via the shared Bullseye-aware resolver", () => {
      const tool = readFileSync(join(MCP_SERVER_SRC, "tools", "start-workspace.ts"), "utf8");
      expect(tool).toMatch(/resolveProviderProfileFromPrefs/);
      expect(tool).toMatch(/@agentic-kanban\/shared\/lib\/strategy-policy/);
    });
  });
});
