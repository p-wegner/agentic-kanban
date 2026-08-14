// @covers butler.pluginOnboarding [correctness, boundary]
//
// #390 gap 4: MEASURED — NO test referenced the plugin-onboarding flow at all, which is how gaps
// 1, 3 and 5 all survived. This is the guard test that ticket asked for. It pins the two things
// that are actually load-bearing and were silently wrong or missing:
//
//  - the ORDERING constraint (#318): enabling SCAFFOLDS, so the output location must be settable
//    in the same call — setting it afterwards leaves the scaffold in the wrong repo;
//  - the board-level butler is no longer plugin-BLIND (gap 1): `getButlerFragments` is
//    project-scoped by construction and could never serve it.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MCP_TOOL = join(__dirname, "../../../mcp-server/src/tools/plugin-onboarding.ts");
const MCP_INDEX = join(__dirname, "../../../mcp-server/src/index.ts");
const BUTLER_ROUTE = join(__dirname, "../routes/butler.ts");
const BOARD_GUIDE = join(__dirname, "../butler/board-guide.ts");

describe("plugin onboarding is reachable as TOOLS, not hand-rolled curl (#390)", () => {
  const source = readFileSync(MCP_TOOL, "utf8");
  const index = readFileSync(MCP_INDEX, "utf8");

  it("registers all four onboarding tools the ticket named", () => {
    for (const tool of ["enable_plugin", "set_plugin_output_location", "get_plugin_scaffold", "fill_plugin_scaffold"]) {
      expect(source, `${tool} definition`).toContain(`"${tool}"`);
      expect(index, `${tool} registration`).toContain(`${tool}:`);
    }
  });

  it("lets enable_plugin take the output location, because enabling SCAFFOLDS (#318)", () => {
    // The whole ordering constraint lives in this one parameter. Without it the butler must
    // enable first and relocate second, which is the sequence that strands the scaffold.
    const enableBlock = source.slice(source.indexOf('"enable_plugin"'), source.indexOf('"set_plugin_output_location"'));
    expect(enableBlock).toContain("location");
    expect(enableBlock).toMatch(/sidecar/);
  });

  it("states the ordering constraint in the DESCRIPTION, where the model reads it", () => {
    // A constraint documented only in a comment is a constraint the model never sees.
    expect(source).toMatch(/enabling SCAFFOLDS/i);
    expect(source).toMatch(/#318/);
  });

  it("tells the model not to invent scaffold answers", () => {
    // The profile drives what every loop generates; an invented answer becomes a wrong register.
    expect(source).toMatch(/answers the user actually gave|ask the USER/i);
  });
});

describe("the board-level butler is no longer plugin-blind (#390 gap 1)", () => {
  const butler = readFileSync(BUTLER_ROUTE, "utf8");

  it("describes installed plugins in the global prompt", () => {
    expect(butler).toContain("describeInstalledPlugins");
    const globalPromptWiring = butler.slice(butler.indexOf("const pluginNote"), butler.indexOf("const wasActive"));
    expect(globalPromptWiring).toContain("GLOBAL_BUTLER_PROJECT_ID");
  });

  it("does NOT try to use the project-scoped fragments for it", () => {
    // `getButlerFragments` resolves {{repoPath}} against a real project, so the global butler
    // cannot use it — pretending otherwise would return silently empty forever.
    const globalBuilder = butler.slice(butler.indexOf("function buildGlobalButlerPrompt"), butler.indexOf("async function resolveButlerPrompt"));
    expect(globalBuilder).not.toContain("getButlerFragments");
  });

  it("keeps the plugin listing best-effort — it must never stop the butler starting", () => {
    const fn = butler.slice(butler.indexOf("async function describeInstalledPlugins"), butler.indexOf("function buildGlobalButlerPrompt"));
    expect(fn).toContain("catch");
    expect(fn).toContain('return "";');
  });
});

describe("the board guide's onboarding prose matches the API (#390 gap 5)", () => {
  const guide = readFileSync(BOARD_GUIDE, "utf8");

  it("uses POST for the scaffold write, not PUT", () => {
    // PUT exists but overwrites the WHOLE file (#438); the interview answers go by POST.
    const scaffoldLines = guide.split(/\r?\n/).filter((l) => /\/scaffold/.test(l));
    expect(scaffoldLines.length).toBeGreaterThan(0);
    for (const line of scaffoldLines) {
      if (/values/.test(line)) expect(line).toMatch(/POST/);
    }
  });
});
