import { describe, expect, it } from "vitest";
import {
  deleteLaunchTemplate,
  launchTemplatesKey,
  sanitizeLaunchTemplates,
  upsertLaunchTemplate,
  applyTemplateToForm,
  type LaunchTemplate,
  type LaunchTemplateOptions,
} from "../launchTemplates.js";

const baseOptions: LaunchTemplateOptions = {
  baseBranch: "develop",
  selectedProfile: "claude:work",
  selectedModel: "sonnet",
  selectedSkillId: "skill-1",
  planMode: true,
  tddMode: false,
  requiresReview: true,
  skipSetup: false,
  skipContextPacker: false,
  isDirect: false,
};

function template(overrides: Partial<LaunchTemplate> = {}): LaunchTemplate {
  return {
    id: "lt-1",
    name: "Standard launch",
    options: baseOptions,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("launchTemplates", () => {
  describe("launchTemplatesKey", () => {
    it("produces the expected preference key", () => {
      expect(launchTemplatesKey("abc-123")).toBe("launch_templates_abc-123");
    });
  });

  describe("sanitizeLaunchTemplates", () => {
    it("returns empty array for undefined input", () => {
      expect(sanitizeLaunchTemplates(undefined)).toEqual([]);
    });

    it("returns empty array for malformed JSON", () => {
      expect(sanitizeLaunchTemplates("not json")).toEqual([]);
    });

    it("returns empty array for non-array JSON", () => {
      expect(sanitizeLaunchTemplates('{"id":"1"}')).toEqual([]);
    });

    it("filters entries missing id or name", () => {
      const raw = JSON.stringify([
        { id: "", name: "No ID" },
        { id: "lt-1", name: "" },
        { id: "lt-2", name: "Valid" },
      ]);
      const result = sanitizeLaunchTemplates(raw);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Valid");
    });

    it("parses valid template array and sorts by name", () => {
      const raw = JSON.stringify([
        template({ id: "lt-b", name: "Zebra" }),
        template({ id: "lt-a", name: "Alpha" }),
      ]);
      const result = sanitizeLaunchTemplates(raw);
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("Alpha");
      expect(result[1].name).toBe("Zebra");
    });

    it("preserves only known option fields", () => {
      const raw = JSON.stringify([{
        id: "lt-1",
        name: "Test",
        options: {
          baseBranch: "main",
          selectedProfile: "codex:default",
          selectedModel: "opus",
          selectedSkillId: "skill-x",
          planMode: true,
          tddMode: true,
          requiresReview: false,
          skipSetup: true,
          skipContextPacker: true,
          isDirect: true,
          unknownField: "should be dropped",
        },
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      }]);
      const result = sanitizeLaunchTemplates(raw);
      expect(result).toHaveLength(1);
      const opts = result[0].options;
      expect(opts.baseBranch).toBe("main");
      expect(opts.selectedProfile).toBe("codex:default");
      expect(opts.selectedModel).toBe("opus");
      expect(opts.selectedSkillId).toBe("skill-x");
      expect(opts.planMode).toBe(true);
      expect(opts.tddMode).toBe(true);
      expect(opts.requiresReview).toBe(false);
      expect(opts.skipSetup).toBe(true);
      expect(opts.skipContextPacker).toBe(true);
      expect(opts.isDirect).toBe(true);
      expect((opts as Record<string, unknown>).unknownField).toBeUndefined();
    });

    it("handles missing options gracefully", () => {
      const raw = JSON.stringify([{ id: "lt-1", name: "No opts" }]);
      const result = sanitizeLaunchTemplates(raw);
      expect(result).toHaveLength(1);
      expect(result[0].options).toEqual({});
    });
  });

  describe("upsertLaunchTemplate", () => {
    it("adds a new template", () => {
      const result = upsertLaunchTemplate([], "New template", baseOptions, "2026-06-01T01:00:00.000Z");
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("New template");
      expect(result[0].options).toEqual(baseOptions);
      expect(result[0].createdAt).toBe("2026-06-01T01:00:00.000Z");
    });

    it("updates existing template by name (case-insensitive)", () => {
      const existing = [template({ name: "Standard launch" })];
      const updated = upsertLaunchTemplate(existing, "standard LAUNCH", { ...baseOptions, planMode: false }, "2026-06-01T02:00:00.000Z");
      expect(updated).toHaveLength(1);
      expect(updated[0].id).toBe("lt-1");
      expect(updated[0].options.planMode).toBe(false);
      expect(updated[0].updatedAt).toBe("2026-06-01T02:00:00.000Z");
      // createdAt preserved from original
      expect(updated[0].createdAt).toBe("2026-06-01T00:00:00.000Z");
    });

    it("ignores empty name", () => {
      const existing = [template()];
      const result = upsertLaunchTemplate(existing, "  ", baseOptions);
      expect(result).toEqual(existing);
    });

    it("generates stable ID for new templates", () => {
      const result = upsertLaunchTemplate([], "First", baseOptions, "2026-06-01T00:00:00.000Z");
      expect(result[0].id).toMatch(/^lt-[a-z0-9]+-[a-z0-9]+$/);
    });
  });

  describe("deleteLaunchTemplate", () => {
    it("removes a template by id", () => {
      const templates = [template({ id: "lt-1" }), template({ id: "lt-2", name: "Other" })];
      const result = deleteLaunchTemplate(templates, "lt-1");
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("lt-2");
    });

    it("returns same array when id not found", () => {
      const templates = [template()];
      const result = deleteLaunchTemplate(templates, "nonexistent");
      expect(result).toEqual(templates);
    });
  });

  describe("applyTemplateToForm", () => {
    it("returns the template options as-is", () => {
      const t = template();
      const formState = applyTemplateToForm(t);
      expect(formState).toEqual(baseOptions);
    });

    it("returns a shallow copy (mutations don't affect original)", () => {
      const t = template();
      const formState = applyTemplateToForm(t);
      formState.baseBranch = "changed";
      expect(t.options.baseBranch).toBe("develop");
    });
  });
});
