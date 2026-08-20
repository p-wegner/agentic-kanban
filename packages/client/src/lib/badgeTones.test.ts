import { describe, expect, it } from "vitest";
import {
  badgeDotClass,
  badgeDotClasses,
  badgeToneClass,
  badgeToneClasses,
  type BadgeTone, WORKSPACE_STATUS_TONE, ISSUE_STATUS_TONE, workspaceStatusToneClass, issueStatusToneClass } from "./badgeTones.js";

const TONES = Object.keys(badgeToneClasses) as BadgeTone[];

describe("badge tones", () => {
  it("covers every tone in both the surface and dot maps", () => {
    expect(TONES.length).toBeGreaterThan(0);
    for (const tone of TONES) {
      expect(badgeDotClasses[tone], `dot class missing for "${tone}"`).toBeTruthy();
    }
  });

  // The regression this file exists for: `blocked`, `estimate` and `overdue`
  // shipped light-mode-only classes and glared on the dark board.
  it.each(TONES)('tone "%s" declares a dark background', (tone) => {
    expect(badgeToneClasses[tone]).toMatch(/\bdark:bg-/);
  });

  it.each(TONES)('tone "%s" declares a dark text colour', (tone) => {
    expect(badgeToneClasses[tone]).toMatch(/\bdark:text-/);
  });

  it.each(TONES)('tone "%s" declares a light background and text colour', (tone) => {
    expect(badgeToneClasses[tone]).toMatch(/(?:^|\s)bg-/);
    expect(badgeToneClasses[tone]).toMatch(/(?:^|\s)text-/);
  });

  it("defaults to the neutral tone", () => {
    expect(badgeToneClass()).toBe(badgeToneClasses.neutral);
    expect(badgeDotClass()).toBe(badgeDotClasses.neutral);
  });

  it("resolves an explicit tone", () => {
    expect(badgeToneClass("danger")).toBe(badgeToneClasses.danger);
    expect(badgeDotClass("success")).toBe(badgeDotClasses.success);
  });

  it("uses a solid (non-transparent) dot colour so it reads on the tone surface", () => {
    for (const tone of TONES) {
      expect(badgeDotClasses[tone]).not.toContain("/");
    }
  });
});

describe("status tones (#517)", () => {
  it("every workspace status maps to a real tone", () => {
    for (const [status, tone] of Object.entries(WORKSPACE_STATUS_TONE)) {
      expect(badgeToneClasses[tone], `workspace status "${status}" -> unknown tone "${tone}"`).toBeDefined();
    }
  });

  it("every issue status maps to a real tone", () => {
    for (const [name, tone] of Object.entries(ISSUE_STATUS_TONE)) {
      expect(badgeToneClasses[tone], `issue status "${name}" -> unknown tone "${tone}"`).toBeDefined();
    }
  });

  it("a status class ALWAYS carries dark background and dark text", () => {
    // The bug this replaces: WS_STATUS_COLORS.closed was
    // `bg-gray-100 text-gray-500 dark:bg-gray-400` — a LIGHT dark-mode background with
    // no dark text, i.e. grey-on-light-grey. Going through a tone makes that impossible.
    for (const status of Object.keys(WORKSPACE_STATUS_TONE)) {
      const cls = workspaceStatusToneClass(status);
      expect(cls, status).toMatch(/dark:bg-/);
      expect(cls, status).toMatch(/dark:text-/);
    }
    for (const name of Object.keys(ISSUE_STATUS_TONE)) {
      const cls = issueStatusToneClass(name);
      expect(cls, name).toMatch(/dark:bg-/);
      expect(cls, name).toMatch(/dark:text-/);
    }
  });

  it("falls back to neutral for an unknown status rather than returning undefined", () => {
    expect(workspaceStatusToneClass("not-a-status")).toBe(badgeToneClasses.neutral);
    expect(workspaceStatusToneClass(null)).toBe(badgeToneClasses.neutral);
    // Custom project columns are legitimate and must not render unstyled.
    expect(issueStatusToneClass("Waiting on Legal")).toBe(badgeToneClasses.neutral);
  });
});
