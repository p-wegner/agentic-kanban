import { describe, it, expect } from "vitest";
import {
  PLUGIN_PLACEHOLDER_KEYS,
  buildPluginPlaceholderVars,
  substitutePluginPlaceholders,
  substitutePluginEnv,
  type PluginPlaceholderVars,
} from "../src/lib/plugin-placeholders.js";

describe("plugin-placeholders (#554)", () => {
  describe("buildPluginPlaceholderVars", () => {
    it("maps outputRepoPath to repoPath and keeps leadingRepoPath separate", () => {
      const vars = buildPluginPlaceholderVars({
        outputRepoPath: "/repos/output",
        leadingRepoPath: "/repos/leading",
        projectName: "demo",
        pluginPath: "/plugins/demo",
        projectId: "proj-1",
      });
      expect(vars.repoPath).toBe("/repos/output");
      expect(vars.leadingRepoPath).toBe("/repos/leading");
      expect(vars.projectName).toBe("demo");
      expect(vars.pluginPath).toBe("/plugins/demo");
      expect(vars.projectId).toBe("proj-1");
    });

    it("omits port when not provided, rather than setting it to undefined explicitly", () => {
      const vars = buildPluginPlaceholderVars({
        outputRepoPath: "/repos/output",
        leadingRepoPath: "/repos/leading",
        projectName: "demo",
        pluginPath: "/plugins/demo",
        projectId: "proj-1",
      });
      expect("port" in vars).toBe(false);
    });

    it("includes port when provided, even as the numeric zero-ish or string form", () => {
      const vars = buildPluginPlaceholderVars({
        outputRepoPath: "/repos/output",
        leadingRepoPath: "/repos/leading",
        projectName: "demo",
        pluginPath: "/plugins/demo",
        projectId: "proj-1",
        port: 4321,
      });
      expect(vars.port).toBe(4321);
    });

    it("passes boardUrl through when given, and leaves it undefined otherwise", () => {
      const withUrl = buildPluginPlaceholderVars({
        outputRepoPath: "/r",
        leadingRepoPath: "/r",
        projectName: "demo",
        pluginPath: "/p",
        projectId: "id",
        boardUrl: "http://localhost:3001",
      });
      expect(withUrl.boardUrl).toBe("http://localhost:3001");

      const withoutUrl = buildPluginPlaceholderVars({
        outputRepoPath: "/r",
        leadingRepoPath: "/r",
        projectName: "demo",
        pluginPath: "/p",
        projectId: "id",
      });
      expect(withoutUrl.boardUrl).toBeUndefined();
    });
  });

  describe("PLUGIN_PLACEHOLDER_KEYS", () => {
    it("lists exactly the keys of PluginPlaceholderVars, in doc-table order", () => {
      expect(PLUGIN_PLACEHOLDER_KEYS).toEqual([
        "repoPath",
        "leadingRepoPath",
        "projectName",
        "pluginPath",
        "port",
        "boardUrl",
        "projectId",
      ]);
    });
  });

  describe("substitutePluginPlaceholders", () => {
    it("replaces every known placeholder present in the text", () => {
      const vars: PluginPlaceholderVars = {
        repoPath: "/repo",
        projectName: "demo",
        boardUrl: "http://localhost:3001",
      };
      const out = substitutePluginPlaceholders(
        "cd {{repoPath}} && echo {{projectName}} {{boardUrl}}",
        vars,
      );
      expect(out).toBe("cd /repo && echo demo http://localhost:3001");
    });

    it("leaves an unknown placeholder untouched", () => {
      const out = substitutePluginPlaceholders("{{notAPlaceholder}}", {});
      expect(out).toBe("{{notAPlaceholder}}");
    });

    it("leaves a known placeholder untouched when its var is not provided", () => {
      // {{port}} at serve time is the documented example of a later pass filling it in.
      const out = substitutePluginPlaceholders("http://localhost:{{port}}", { repoPath: "/x" });
      expect(out).toBe("http://localhost:{{port}}");
    });

    it("treats the placeholder token as a literal, not a regex", () => {
      // Braces are regex metacharacters; a naive `new RegExp` construction would behave
      // differently here. split/join must not choke on repeated or adjacent tokens.
      const out = substitutePluginPlaceholders("{{repoPath}}{{repoPath}}", { repoPath: "X" });
      expect(out).toBe("XX");
    });

    it("stringifies a numeric port value", () => {
      const out = substitutePluginPlaceholders("port={{port}}", { port: 8080 });
      expect(out).toBe("port=8080");
    });
  });

  describe("substitutePluginEnv", () => {
    it("applies substitution to every value in the env map", () => {
      const out = substitutePluginEnv(
        { REPO: "{{repoPath}}", PORT: "{{port}}", STATIC: "unchanged" },
        { repoPath: "/repo", port: 9000 },
      );
      expect(out).toEqual({ REPO: "/repo", PORT: "9000", STATIC: "unchanged" });
    });

    it("returns an empty object for undefined env", () => {
      expect(substitutePluginEnv(undefined, { repoPath: "/repo" })).toEqual({});
    });

    it("returns an empty object for an empty env map", () => {
      expect(substitutePluginEnv({}, { repoPath: "/repo" })).toEqual({});
    });
  });
});
