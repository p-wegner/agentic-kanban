import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexProvider } from "../services/agent-provider/codex-provider.js";
import {
  BUILDER_CONTEXT_SUPPORT,
  codexIsolationConfigArgs,
  discoverCodexUserScope,
  effectiveCodexHome,
} from "../services/agent-provider/builder-context.js";

const fakeFs = { existsSync: () => false, readFileSync: () => "", writeFileSync: () => {} };
const base = { agentCommand: "codex", prompt: "p", provider: "codex" as const };

describe("codex builder context (#1310)", () => {
  const provider = new CodexProvider(fakeFs);
  const scope = { mcpServers: ["node_repl"], skillPaths: ["C:/h/.codex/skills/a/SKILL.md"] };

  it("is declared supported", () => {
    expect(BUILDER_CONTEXT_SUPPORT.codex).toBe("supported");
  });

  it("isolated adds the overrides before `resume`", () => {
    const { args } = provider.buildLaunchConfig({
      ...base,
      providerSessionId: "sess-1",
      builderContext: { policy: "isolated", codexUserScope: scope },
    });
    const joined = args.join(" ");
    expect(joined).toContain("-c notify=[]");
    expect(joined).toContain("-c features.plugins=false");
    expect(joined).toContain("-c skills.bundled.enabled=false");
    expect(joined).toContain("-c mcp_servers.node_repl.enabled=false");
    expect(joined).toContain("-c skills.config=[{path='C:/h/.codex/skills/a/SKILL.md',enabled=false}]");
    expect(args.lastIndexOf("-c")).toBeLessThan(args.indexOf("resume"));
  });

  it("inherit and absent context leave the args unchanged", () => {
    const plain = provider.buildLaunchConfig({ ...base }).args;
    expect(provider.buildLaunchConfig({ ...base, builderContext: { policy: "inherit" } }).args).toEqual(plain);
    expect(plain).not.toContain("-c");
  });

  it("keeps profile and model while isolating", () => {
    const { args } = provider.buildLaunchConfig({
      ...base,
      model: "gpt-x",
      profile: { provider: "codex", name: "work" } as never,
      builderContext: { policy: "isolated" },
    });
    expect(args).toEqual(expect.arrayContaining(["--profile", "work", "--model", "gpt-x"]));
  });

  it("discovers user MCP servers and skills by name, never the board's own server", () => {
    const home = mkdtempSync(join(tmpdir(), "ak-1310-"));
    try {
      writeFileSync(
        join(home, "config.toml"),
        ["[mcp_servers.node_repl]", "command = 'secret'", "[mcp_servers.node_repl.env]", "[mcp_servers.agentic-kanban]", "[plugins.\"x@y\"]"].join("\n"),
      );
      mkdirSync(join(home, "skills", "mine"), { recursive: true });
      writeFileSync(join(home, "skills", "mine", "SKILL.md"), "x");
      mkdirSync(join(home, "skills", ".system", "bundled"), { recursive: true });
      mkdirSync(join(home, "skills", "empty"), { recursive: true });
      const found = discoverCodexUserScope(home);
      expect(found.mcpServers).toEqual(["node_repl"]);
      expect(found.skillPaths).toEqual([join(home, "skills", "mine", "SKILL.md")]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("an unreadable home yields nothing, the license ring's CODEX_HOME wins", () => {
    expect(discoverCodexUserScope(join(tmpdir(), "ak1310-does-not-exist"))).toEqual({ mcpServers: [], skillPaths: [] });
    expect(effectiveCodexHome({ CODEX_HOME: "D:/lic" }, { CODEX_HOME: "D:/env" })).toBe("D:/lic");
    expect(effectiveCodexHome(undefined, { CODEX_HOME: "D:/env" })).toBe("D:/env");
    expect(codexIsolationConfigArgs()).toContain("notify=[]");
  });
});
