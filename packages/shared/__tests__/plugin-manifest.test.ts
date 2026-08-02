import { describe, expect, it } from "vitest";
import {
  parsePluginManifest,
  PluginManifestError,
  substitutePluginPlaceholders,
  substitutePluginEnv,
  pluginEnabledPreferenceKey,
  parsePluginLoopPlan,
  pluginLoopUnitKey,
  pluginLoopPausedPreferenceKey,
} from "../src/lib/plugin-manifest.js";
import {
  isPluginEnabledPreferenceKey,
  isPluginLoopPausedPreferenceKey,
  isProjectScopedDynamicKey,
} from "../src/lib/dynamic-preference-keys.js";

const FULL_MANIFEST = {
  id: "refactor-safety-net",
  name: "Refactor Safety Net",
  version: "0.1.0",
  skills: [{ dir: ".claude/skills/requirement-extraction" }],
  views: [
    {
      id: "coverage",
      label: "Coverage",
      kind: "iframe",
      serve: {
        command: "node tools/coverage/serve.mjs",
        portEnv: "PORT",
        env: { COVERAGE_ROOT: "{{repoPath}}" },
      },
    },
  ],
  scripts: [
    { name: "coverage", command: "npm run coverage", cwd: "plugin", env: { COVERAGE_ROOT: "{{repoPath}}" } },
  ],
  butler: { promptFragment: "butler-fragment.md" },
  scaffold: { profileTemplate: "profile-template.md", targetPath: "docs/analysis/_project-profile.md" },
};

describe("parsePluginManifest", () => {
  it("parses a full valid manifest from JSON text", () => {
    const m = parsePluginManifest(JSON.stringify(FULL_MANIFEST));
    expect(m.id).toBe("refactor-safety-net");
    expect(m.name).toBe("Refactor Safety Net");
    expect(m.version).toBe("0.1.0");
    expect(m.skills).toEqual([{ dir: ".claude/skills/requirement-extraction" }]);
    expect(m.views?.[0]).toMatchObject({ id: "coverage", kind: "iframe" });
    expect(m.views?.[0].serve.portEnv).toBe("PORT");
    expect(m.scripts?.[0]).toMatchObject({ name: "coverage", cwd: "plugin" });
    expect(m.butler?.promptFragment).toBe("butler-fragment.md");
    expect(m.scaffold?.targetPath).toBe("docs/analysis/_project-profile.md");
  });

  it("parses a minimal manifest (id + name only)", () => {
    const m = parsePluginManifest({ id: "x1", name: "X" });
    expect(m).toMatchObject({ id: "x1", name: "X" });
    expect(m.skills).toBeUndefined();
    expect(m.views).toBeUndefined();
  });

  it("rejects invalid JSON text with a clear error", () => {
    expect(() => parsePluginManifest("{nope")).toThrow(PluginManifestError);
    expect(() => parsePluginManifest("{nope")).toThrow(/not valid JSON/);
  });

  it("rejects a missing or malformed id", () => {
    expect(() => parsePluginManifest({ name: "X" })).toThrow(/"id" must be a non-empty string/);
    expect(() => parsePluginManifest({ id: "Bad_Slug!", name: "X" })).toThrow(/"id" must match/);
  });

  it("rejects a view without serve.command and a non-iframe kind", () => {
    expect(() =>
      parsePluginManifest({ id: "p", name: "P", views: [{ id: "v", label: "V", kind: "iframe", serve: {} }] }),
    ).toThrow(/views\[0]\.serve\.command/);
    expect(() =>
      parsePluginManifest({ id: "p", name: "P", views: [{ id: "v", label: "V", kind: "panel", serve: { command: "x" } }] }),
    ).toThrow(/kind must be "iframe"/);
  });

  it("rejects duplicate view ids and script names", () => {
    const view = { id: "v", label: "V", kind: "iframe", serve: { command: "x" } };
    expect(() => parsePluginManifest({ id: "p", name: "P", views: [view, view] })).toThrow(/duplicate view id/);
    const script = { name: "s", command: "x" };
    expect(() => parsePluginManifest({ id: "p", name: "P", scripts: [script, script] })).toThrow(/duplicate script name/);
  });

  it("rejects a bad script cwd", () => {
    expect(() =>
      parsePluginManifest({ id: "p", name: "P", scripts: [{ name: "s", command: "x", cwd: "elsewhere" }] }),
    ).toThrow(/cwd" must be "plugin" or "repo"/);
  });

  it("rejects absolute and parent-escaping manifest paths", () => {
    expect(() => parsePluginManifest({ id: "p", name: "P", skills: [{ dir: "/etc" }] })).toThrow(/relative path/);
    expect(() => parsePluginManifest({ id: "p", name: "P", skills: [{ dir: "C:/x" }] })).toThrow(/relative path/);
    expect(() =>
      parsePluginManifest({ id: "p", name: "P", scaffold: { profileTemplate: "t.md", targetPath: "../outside.md" } }),
    ).toThrow(/must not contain ".."/);
  });
});

describe("substitutePluginPlaceholders", () => {
  it("substitutes all supported placeholders", () => {
    const text = "{{repoPath}}|{{projectName}}|{{pluginPath}}|{{port}}";
    expect(
      substitutePluginPlaceholders(text, { repoPath: "C:/r", projectName: "proj", pluginPath: "C:/p", port: 4321 }),
    ).toBe("C:/r|proj|C:/p|4321");
  });

  it("leaves unknown and unprovided placeholders untouched", () => {
    expect(substitutePluginPlaceholders("{{port}} {{mystery}}", { repoPath: "r" })).toBe("{{port}} {{mystery}}");
  });

  it("substitutes env maps value-wise", () => {
    expect(substitutePluginEnv({ A: "{{repoPath}}/x", B: "static" }, { repoPath: "C:/r" })).toEqual({
      A: "C:/r/x",
      B: "static",
    });
    expect(substitutePluginEnv(undefined, { repoPath: "r" })).toEqual({});
  });
});

describe("plugin enable preference key", () => {
  const projectId = "0b6f38e1-2f14-4a5c-9d3e-77aa00bb11cc";

  it("builds and recognizes the key, including dash-bearing slugs", () => {
    const key = pluginEnabledPreferenceKey("refactor-safety-net", projectId);
    expect(key).toBe(`plugin_enabled_refactor-safety-net_${projectId}`);
    expect(isPluginEnabledPreferenceKey(key)).toBe(true);
    expect(isProjectScopedDynamicKey(key)).toBe(true);
  });

  it("rejects malformed keys", () => {
    expect(isPluginEnabledPreferenceKey(`plugin_enabled_Bad!_${projectId}`)).toBe(false);
    expect(isPluginEnabledPreferenceKey("plugin_enabled_slug_not-a-uuid")).toBe(false);
    expect(isPluginEnabledPreferenceKey(`plugin_enabled_${projectId}`)).toBe(false);
  });
});

describe("plugin loop pause preference key", () => {
  const projectId = "0b6f38e1-2f14-4a5c-9d3e-77aa00bb11cc";

  it("builds and recognizes the key, including dash-bearing slug and loop names", () => {
    const key = pluginLoopPausedPreferenceKey("refactor-safety-net", "requirement-extraction", projectId);
    expect(key).toBe(`plugin_loop_paused_refactor-safety-net_requirement-extraction_${projectId}`);
    expect(isPluginLoopPausedPreferenceKey(key)).toBe(true);
    expect(isProjectScopedDynamicKey(key)).toBe(true);
  });

  it("rejects malformed keys", () => {
    expect(isPluginLoopPausedPreferenceKey(`plugin_loop_paused_slug_loop_not-a-uuid`)).toBe(false);
    expect(isPluginLoopPausedPreferenceKey(`plugin_loop_paused_${projectId}`)).toBe(false);
  });
});

describe("plugin manifest — converging loops", () => {
  const LOOP_MANIFEST = {
    id: "refactor-safety-net",
    name: "Refactor Safety Net",
    skills: [{ dir: ".claude/skills/requirement-extraction" }],
    loops: [
      {
        name: "requirement-extraction",
        label: "Requirement extraction",
        skill: "requirement-extraction",
        plan: { command: "node tools/loop-plan.mjs --json", cwd: "plugin", env: { ROOT: "{{repoPath}}" } },
      },
    ],
  };

  it("parses a loop with its plan command, cwd and env", () => {
    const manifest = parsePluginManifest(LOOP_MANIFEST);
    expect(manifest.loops).toHaveLength(1);
    expect(manifest.loops?.[0]).toMatchObject({
      name: "requirement-extraction",
      skill: "requirement-extraction",
      plan: { command: "node tools/loop-plan.mjs --json", cwd: "plugin" },
    });
  });

  it("rejects a loop whose skill the manifest never declares", () => {
    const broken = { ...LOOP_MANIFEST, loops: [{ ...LOOP_MANIFEST.loops[0], skill: "nope" }] };
    expect(() => parsePluginManifest(broken)).toThrow(PluginManifestError);
    expect(() => parsePluginManifest(broken)).toThrow(/not one of the manifest's skills/);
  });

  it("rejects duplicate loop names and a non-positive unit cap", () => {
    expect(() => parsePluginManifest({ ...LOOP_MANIFEST, loops: [LOOP_MANIFEST.loops[0], LOOP_MANIFEST.loops[0]] }))
      .toThrow(/duplicate loop name/);
    expect(() => parsePluginManifest({
      ...LOOP_MANIFEST,
      loops: [{ ...LOOP_MANIFEST.loops[0], maxUnitsPerAdvance: 0 }],
    })).toThrow(/positive integer/);
  });

  it("rejects an unknown cwd on a script, a view serve, and a loop plan alike", () => {
    expect(() => parsePluginManifest({
      ...LOOP_MANIFEST,
      loops: [{ ...LOOP_MANIFEST.loops[0], plan: { command: "x", cwd: "elsewhere" } }],
    })).toThrow(/must be "plugin" or "repo"/);
  });
});

describe("parsePluginLoopPlan", () => {
  it("reads the last JSON value, so a shell banner ahead of the plan is tolerated", () => {
    const plan = parsePluginLoopPlan(
      'npm notice something\n{"units":[{"id":"billing:r1","title":"Mine billing"}],"note":"1/4 converged"}\n',
    );
    expect(plan.units).toEqual([{ id: "billing:r1", title: "Mine billing", description: undefined }]);
    expect(plan.note).toBe("1/4 converged");
    expect(plan.converged).toBe(false);
  });

  it("accepts a bare array and treats an empty plan as converged", () => {
    expect(parsePluginLoopPlan("[]")).toMatchObject({ units: [], converged: true });
    expect(parsePluginLoopPlan('[{"id":"a","title":"A"}]').units).toHaveLength(1);
  });

  it("lets a planner report 'not converged, but nothing to do' explicitly", () => {
    expect(parsePluginLoopPlan('{"units":[],"converged":false}')).toMatchObject({ units: [], converged: false });
  });

  it("rejects empty output, non-JSON output, and repeated unit ids", () => {
    expect(() => parsePluginLoopPlan("   ")).toThrow(/printed no output/);
    expect(() => parsePluginLoopPlan("boom: command not found")).toThrow(/not JSON/);
    expect(() => parsePluginLoopPlan('{"units":[{"id":"a","title":"A"},{"id":"a","title":"B"}]}'))
      .toThrow(/repeats unit id/);
  });
});

describe("pluginLoopUnitKey", () => {
  it("namespaces by plugin and loop so one project can run several loops", () => {
    expect(pluginLoopUnitKey("refactor-safety-net", "requirement-extraction", "billing:r1"))
      .toBe("plugin-loop:refactor-safety-net:requirement-extraction:billing:r1");
    // The empty-unit form is the prefix the loop engine dedupes on.
    expect(pluginLoopUnitKey("a", "b", "").endsWith(":")).toBe(true);
  });
});
