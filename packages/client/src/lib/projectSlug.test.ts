import { describe, expect, it } from "vitest";
import {
  buildProjectSlugMap,
  resolveProjectIdFromSlug,
  slugifyProjectName,
  type SlugProject,
} from "./projectSlug";

describe("slugifyProjectName", () => {
  it("lowercases and hyphenates", () => {
    expect(slugifyProjectName("Agentic Kanban")).toBe("agentic-kanban");
    expect(slugifyProjectName("MealPlan")).toBe("mealplan");
  });

  it("strips diacritics", () => {
    expect(slugifyProjectName("Café Münster")).toBe("cafe-munster");
    expect(slugifyProjectName("Straße")).toBe("strasse");
    expect(slugifyProjectName("Ångström")).toBe("angstrom");
  });

  it("collapses runs of non-alphanumerics and trims edges", () => {
    expect(slugifyProjectName("  ---Hello___World!!!  ")).toBe("hello-world");
    expect(slugifyProjectName("a/b\\c.d")).toBe("a-b-c-d");
    expect(slugifyProjectName("2024 Q3 // roadmap")).toBe("2024-q3-roadmap");
  });

  it("caps length without a trailing hyphen", () => {
    const slug = slugifyProjectName("x".repeat(80));
    expect(slug).toHaveLength(48);
    const wordy = slugifyProjectName(`${"a".repeat(47)} tail`);
    expect(wordy.length).toBeLessThanOrEqual(48);
    expect(wordy.endsWith("-")).toBe(false);
  });

  it("falls back to 'project' when nothing usable remains", () => {
    expect(slugifyProjectName("")).toBe("project");
    expect(slugifyProjectName("   ")).toBe("project");
    expect(slugifyProjectName("!!!")).toBe("project");
    expect(slugifyProjectName("日本語")).toBe("project");
  });
});

const p = (id: string, name: string): SlugProject => ({ id, name });

describe("buildProjectSlugMap", () => {
  it("maps ids to plain slugs when there is no collision", () => {
    const map = buildProjectSlugMap([p("aaa111", "Agentic Kanban"), p("bbb222", "Meal Plan")]);
    expect(map.get("aaa111")).toBe("agentic-kanban");
    expect(map.get("bbb222")).toBe("meal-plan");
  });

  it("disambiguates EVERY colliding entry, not just the later ones", () => {
    const projects = [p("abcdef01-aaaa", "Pantry"), p("ffffff99-bbbb", "pantry!")];
    const map = buildProjectSlugMap(projects);
    expect(map.get("abcdef01-aaaa")).toBe("pantry-abcdef");
    expect(map.get("ffffff99-bbbb")).toBe("pantry-ffffff");
  });

  it("does not change an existing project's slug when a colliding project is added", () => {
    const before = buildProjectSlugMap([p("abcdef01", "Pantry"), p("999999zz", "Other")]);
    expect(before.get("abcdef01")).toBe("pantry");

    const after = buildProjectSlugMap([
      p("abcdef01", "Pantry"),
      p("999999zz", "Other"),
      p("123456aa", "PANTRY"),
    ]);
    // Both colliding entries are disambiguated — non-colliding ones are untouched.
    expect(after.get("abcdef01")).toBe("pantry-abcdef");
    expect(after.get("123456aa")).toBe("pantry-123456");
    expect(after.get("999999zz")).toBe(before.get("999999zz"));
  });

  it("is order-independent", () => {
    const projects = [p("abcdef01", "Pantry"), p("123456aa", "pantry"), p("zzzzzz11", "Other")];
    const forward = buildProjectSlugMap(projects);
    const reversed = buildProjectSlugMap([...projects].reverse());
    expect([...reversed].sort()).toEqual([...forward].sort());
    for (const [id, slug] of forward) expect(reversed.get(id)).toBe(slug);
  });

  it("falls back to the full id when the 6-char prefix still collides", () => {
    const projects = [p("abcdef-1", "Pantry"), p("abcdef-2", "pantry")];
    const map = buildProjectSlugMap(projects);
    expect(map.get("abcdef-1")).toBe("abcdef-1");
    expect(map.get("abcdef-2")).toBe("abcdef-2");
  });

  it("produces unique slugs even when all names are unusable", () => {
    const projects = [p("aaaaaa11", "!!!"), p("bbbbbb22", "???"), p("cccccc33", "")];
    const map = buildProjectSlugMap(projects);
    expect(new Set(map.values()).size).toBe(3);
  });

  it("ignores entries without an id and keeps the first of a duplicate id", () => {
    const map = buildProjectSlugMap([
      p("", "No Id"),
      p("dup", "First"),
      p("dup", "Second"),
    ]);
    expect(map.size).toBe(1);
    expect(map.get("dup")).toBe("first");
  });
});

describe("resolveProjectIdFromSlug", () => {
  const projects = [p("abcdef01", "Agentic Kanban"), p("999999zz", "Meal Plan")];

  it("resolves a slug", () => {
    expect(resolveProjectIdFromSlug("agentic-kanban", projects)).toBe("abcdef01");
  });

  it("resolves a raw project id", () => {
    expect(resolveProjectIdFromSlug("999999zz", projects)).toBe("999999zz");
  });

  it("is case-insensitive on the slug", () => {
    expect(resolveProjectIdFromSlug("Agentic-Kanban", projects)).toBe("abcdef01");
    expect(resolveProjectIdFromSlug("AGENTIC-KANBAN", projects)).toBe("abcdef01");
  });

  it("returns null for unknown or empty input", () => {
    expect(resolveProjectIdFromSlug("nope", projects)).toBeNull();
    expect(resolveProjectIdFromSlug("", projects)).toBeNull();
    expect(resolveProjectIdFromSlug("agentic-kanban", [])).toBeNull();
  });

  it("resolves disambiguated slugs round-trip", () => {
    const colliding = [p("abcdef01", "Pantry"), p("123456aa", "pantry")];
    for (const [id, slug] of buildProjectSlugMap(colliding)) {
      expect(resolveProjectIdFromSlug(slug, colliding)).toBe(id);
    }
  });
});
