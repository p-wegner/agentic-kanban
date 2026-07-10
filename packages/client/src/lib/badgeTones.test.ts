import { describe, expect, it } from "vitest";
import {
  badgeDotClass,
  badgeDotClasses,
  badgeToneClass,
  badgeToneClasses,
  type BadgeTone,
} from "./badgeTones.js";

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
