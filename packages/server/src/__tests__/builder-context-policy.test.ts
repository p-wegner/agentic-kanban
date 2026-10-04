import { describe, it, expect, vi } from "vitest";
import { ClaudeProvider } from "../services/agent-provider/claude-provider.js";
import {
  parseBuilderContextPolicy,
  parseBuilderAutocompact,
  parseBuilderEffort,
  resolveBuilderContext,
  builderContextPref,
  builderEffortPref,
  builderAutocompactPref,
  BUILDER_CONTEXT_SUPPORT,
} from "../services/agent-provider/builder-context.js";
import { isProjectScopedDynamicKey } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { PROVIDER_NAMES } from "../services/agent-provider/types.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn(), execSync: vi.fn() }));

const fakeFs = { existsSync: () => false, readFileSync: () => "", writeFileSync: () => {} };

describe("builder context policy (#1302)", () => {
  const provider = new ClaudeProvider(fakeFs);
  const base = { agentCommand: "claude", prompt: "hi" };

  it("isolated adds --setting-sources project,local", () => {
    const { args } = provider.buildLaunchConfig({ ...base, builderContext: { policy: "isolated" } });
    const i = args.indexOf("--setting-sources");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("project,local");
  });

  it("inherit reproduces today's launch args exactly", () => {
    const today = provider.buildLaunchConfig({ ...base });
    const inherit = provider.buildLaunchConfig({ ...base, builderContext: { policy: "inherit" } });
    expect(inherit.args).toEqual(today.args);
    expect(inherit.args).not.toContain("--setting-sources");
  });

  it("parses unset and unknown values to the isolated default", () => {
    expect(parseBuilderContextPolicy(undefined)).toBe("isolated");
    expect(parseBuilderContextPolicy("bogus")).toBe("isolated");
    expect(parseBuilderContextPolicy(" Inherit ")).toBe("inherit");
  });

  it("the per-project key is an accepted dynamic preference key", () => {
    const key = builderContextPref.key("0a1b2c3d-0000-4000-8000-000000000001");
    expect(isProjectScopedDynamicKey(key)).toBe(true);
  });

  it("every provider is declared supported or unsupported with a reason", () => {
    for (const name of PROVIDER_NAMES) expect(BUILDER_CONTEXT_SUPPORT[name]).toBeTruthy();
  });
});

describe("pinned builder tuning: --effort / --autocompact", () => {
  const provider = new ClaudeProvider(fakeFs);
  const base = { agentCommand: "claude", prompt: "hi" };
  const pid = "0a1b2c3d-0000-4000-8000-000000000001";
  const prefs = (map: Record<string, string>) => async (key: string) => map[key];
  const flag = (args: string[], name: string) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };

  it("isolated with no prefs pins the defaults the user scope used to supply", async () => {
    const ctx = await resolveBuilderContext(true, pid, "ws", prefs({}));
    expect(ctx).toEqual({ policy: "isolated", effort: "medium", autocompact: "500000" });
    const { args } = provider.buildLaunchConfig({ ...base, builderContext: ctx });
    expect(flag(args, "--effort")).toBe("medium");
    expect(flag(args, "--autocompact")).toBe("500000");
  });

  it("per-project prefs override the defaults", async () => {
    const ctx = await resolveBuilderContext(true, pid, "ws", prefs({
      [builderEffortPref.key(pid)]: "high",
      [builderAutocompactPref.key(pid)]: "auto",
    }));
    const { args } = provider.buildLaunchConfig({ ...base, builderContext: ctx });
    expect(flag(args, "--effort")).toBe("high");
    expect(flag(args, "--autocompact")).toBe("auto");
  });

  it("inherit with no prefs adds no flag, so the launch is unchanged", async () => {
    const ctx = await resolveBuilderContext(true, pid, "ws", prefs({ [builderContextPref.key(pid)]: "inherit" }));
    expect(ctx).toEqual({ policy: "inherit" });
    expect(provider.buildLaunchConfig({ ...base, builderContext: ctx }).args).toEqual(provider.buildLaunchConfig(base).args);
  });

  it("inherit still passes a pref the operator set explicitly", async () => {
    const ctx = await resolveBuilderContext(true, pid, "ws", prefs({
      [builderContextPref.key(pid)]: "inherit",
      [builderEffortPref.key(pid)]: "low",
    }));
    expect(flag(provider.buildLaunchConfig({ ...base, builderContext: ctx }).args, "--effort")).toBe("low");
  });

  it("not a Claude builder: nothing resolved", async () => {
    expect(await resolveBuilderContext(false, pid, "ws", prefs({}))).toBeUndefined();
  });

  it("rejects values the CLI would refuse, so the default decides", () => {
    expect(parseBuilderEffort("turbo")).toBeUndefined();
    expect(parseBuilderEffort(" XHigh ")).toBe("xhigh");
    expect(parseBuilderAutocompact("50000")).toBeUndefined();
    expect(parseBuilderAutocompact("2000000")).toBeUndefined();
    expect(parseBuilderAutocompact("abc")).toBeUndefined();
    expect(parseBuilderAutocompact("600000")).toBe("600000");
  });

  it("both new per-project keys are accepted dynamic preference keys", () => {
    expect(isProjectScopedDynamicKey(builderEffortPref.key(pid))).toBe(true);
    expect(isProjectScopedDynamicKey(builderAutocompactPref.key(pid))).toBe(true);
  });
});
