import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeProvider } from "../services/agent-provider/claude-provider.js";
import { resolveBuilderContext, builderContextPref } from "../services/agent-provider/builder-context.js";
import {
  builderProfilePref,
  parseBuilderLeanProfile,
  LEAN_DISALLOWED_TOOLS,
  CORE_BUILDER_SKILLS,
} from "../services/agent-provider/builder-lean-profile.js";
import { writeBuilderSkillListing } from "../services/builder-skill-listing.service.js";
import { isProjectScopedDynamicKey } from "@agentic-kanban/shared/lib/dynamic-preference-keys";

vi.mock("node:child_process", () => ({ spawn: vi.fn(), execSync: vi.fn() }));
vi.mock("@agentic-kanban/shared/lib/git-exec", () => ({
  gitExec: vi.fn(async () => ({ stdout: "", stderr: "", code: 1, error: null })),
}));

const fakeFs = { existsSync: () => false, readFileSync: () => "", writeFileSync: () => {} };
const pid = "0a1b2c3d-0000-4000-8000-000000000001";
const prefs = (map: Record<string, string>) => async (key: string) => map[key];
const provider = new ClaudeProvider(fakeFs);
const base = { agentCommand: "claude", prompt: "hi" };
const flag = (args: string[], name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

describe("lean Claude builder profile (#1312)", () => {
  it("isolated Claude builder: lean args and env by default", async () => {
    const ctx = await resolveBuilderContext(true, pid, "ws", prefs({}), true);
    const cfg = provider.buildLaunchConfig({ ...base, builderContext: ctx });
    expect(flag(cfg.args, "--disallowedTools")?.split(",")).toEqual([...LEAN_DISALLOWED_TOOLS]);
    expect(cfg.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    expect(cfg.env?.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
  });

  it("inherit and non-Claude contexts stay byte-identical to today", async () => {
    const today = provider.buildLaunchConfig(base);
    const ctx = await resolveBuilderContext(true, pid, "ws", prefs({ [builderContextPref.key(pid)]: "inherit" }), true);
    expect(ctx?.lean).toBeUndefined();
    const inherit = provider.buildLaunchConfig({ ...base, builderContext: ctx });
    expect(inherit.args).toEqual(today.args);
    expect(inherit.env).toEqual(today.env);
    const noLean = await resolveBuilderContext(true, pid, "ws", prefs({}));
    expect(noLean?.lean).toBeUndefined();
    expect(provider.buildLaunchConfig({ ...base, builderContext: noLean }).args).not.toContain("--disallowedTools");
  });

  it("add-backs: tools.add, autoMemory, mcp.claudeAi, mcp.configs, plugins", async () => {
    const raw = JSON.stringify({
      autoMemory: true,
      tools: { add: ["Workflow"] },
      skills: { full: ["scope-guard"] },
      mcp: { claudeAi: true, configs: ["C:/x/extra.json"] },
      plugins: ["C:/p/plug"],
    });
    const ctx = await resolveBuilderContext(true, pid, "ws", prefs({ [builderProfilePref.key(pid)]: raw }), true);
    const cfg = provider.buildLaunchConfig({ ...base, builderContext: ctx });
    const disallowed = flag(cfg.args, "--disallowedTools")!.split(",");
    expect(disallowed).not.toContain("Workflow");
    expect(disallowed).toContain("ScheduleWakeup");
    expect(cfg.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBeUndefined();
    expect(cfg.env?.ENABLE_CLAUDEAI_MCP_SERVERS).toBeUndefined();
    expect(cfg.args).toContain("C:/x/extra.json");
    expect(flag(cfg.args, "--plugin-dir")).toBe("C:/p/plug");
    expect(ctx?.lean?.skillsFull).toEqual(["scope-guard"]);
  });

  it("an unparseable pref falls back to the lean base", () => {
    expect(parseBuilderLeanProfile("{nope").disallowedTools).toEqual([...LEAN_DISALLOWED_TOOLS]);
    expect(parseBuilderLeanProfile("[1]").autoMemory).toBe(false);
  });

  it("the pref key is an accepted dynamic preference key", () => {
    expect(isProjectScopedDynamicKey(builderProfilePref.key(pid))).toBe(true);
  });
});

describe("lean builder skill listing (#1312)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ak-lean-skills-"));
    for (const n of ["scope-guard", "other-skill", "extra-skill", "kept-plugin-skill"]) mkdirSync(join(dir, ".claude", "skills", n), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const read = () => JSON.parse(readFileSync(join(dir, ".claude", "settings.local.json"), "utf8"));

  it("lists non-core skills name-only, core ones untouched", async () => {
    expect("scope-guard" in CORE_BUILDER_SKILLS).toBe(true);
    const res = await writeBuilderSkillListing(dir, []);
    expect(res.status).toBe("written");
    expect(read().skillOverrides).toEqual({ "other-skill": "name-only", "extra-skill": "name-only", "kept-plugin-skill": "name-only" });
  });

  it("skills.full keeps a skill in full, even after an earlier name-only", async () => {
    await writeBuilderSkillListing(dir, []);
    await writeBuilderSkillListing(dir, ["extra-skill"]);
    expect(read().skillOverrides["extra-skill"]).toBeUndefined();
    expect(read().skillOverrides["other-skill"]).toBe("name-only");
  });

  it("leaves an existing override alone", async () => {
    writeFileSync(join(dir, ".claude", "settings.local.json"), JSON.stringify({ skillOverrides: { "kept-plugin-skill": "on" }, other: 1 }));
    await writeBuilderSkillListing(dir, []);
    expect(read().skillOverrides["kept-plugin-skill"]).toBe("on");
    expect(read().other).toBe(1);
  });
});

