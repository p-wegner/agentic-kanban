import { describe, expect, it } from "vitest";
import {
  buttonSizeClass,
  buttonSizeClasses,
  buttonVariantClass,
  buttonVariantClasses,
  iconButtonSizeClass,
  iconButtonSizeClasses,
  type ButtonSize,
  type ButtonVariant,
} from "./buttonVariants.js";

const VARIANTS = Object.keys(buttonVariantClasses) as ButtonVariant[];
const SIZES = Object.keys(buttonSizeClasses) as ButtonSize[];

describe("button variants", () => {
  it("declares at least one variant and size", () => {
    expect(VARIANTS.length).toBeGreaterThan(0);
    expect(SIZES.length).toBeGreaterThan(0);
  });

  // The regression this file exists to prevent (same class of bug as badgeTones):
  // a variant shipping light-mode-only classes that glare on the dark board.
  it.each(VARIANTS)('variant "%s" declares a dark-mode hover state', (variant) => {
    expect(buttonVariantClasses[variant]).toMatch(/\bdark:hover:/);
  });

  it.each(VARIANTS)('variant "%s" declares a hover state', (variant) => {
    expect(buttonVariantClasses[variant]).toMatch(/(?:^|\s)hover:/);
  });

  // Coloured (primary/danger) variants use white text in both modes; neutral
  // variants (secondary/ghost) that set an ink/stone text colour must pair it
  // with a `dark:` sibling — otherwise the text is unreadable on the dark surface.
  it.each(VARIANTS)('variant "%s" pairs any non-white text colour with a dark: sibling', (variant) => {
    const classes = buttonVariantClasses[variant];
    const hasNeutralText = /(?:^|\s)text-(?:ink|stone|gray)/.test(classes);
    if (hasNeutralText) {
      expect(classes, `"${variant}" sets a neutral text colour without a dark: variant`).toMatch(
        /\bdark:text-/,
      );
    }
  });

  it.each(VARIANTS)('variant "%s" declares a focus-visible ring for keyboard a11y', (variant) => {
    expect(buttonVariantClasses[variant]).toMatch(/\bfocus-visible:ring-/);
  });

  it("routes neutral surfaces onto the warm editorial palette, not cold gray", () => {
    // The whole point of the primitive is to stop hand-rolled `gray-*` neutrals;
    // the theme (app.css) ships warm surface/ink/stone tokens instead.
    for (const variant of VARIANTS) {
      expect(buttonVariantClasses[variant], `"${variant}" uses cold gray-*`).not.toMatch(
        /(?:^|\s|:)(?:bg|text|border)-gray-/,
      );
    }
  });

  it("keeps text and icon-only size maps in lockstep on the same keys", () => {
    expect(Object.keys(iconButtonSizeClasses).sort()).toEqual(SIZES.slice().sort());
  });

  it("defaults to the primary variant and md size", () => {
    expect(buttonVariantClass()).toBe(buttonVariantClasses.primary);
    expect(buttonSizeClass()).toBe(buttonSizeClasses.md);
    expect(iconButtonSizeClass()).toBe(iconButtonSizeClasses.md);
  });

  it("resolves an explicit variant and size", () => {
    expect(buttonVariantClass("danger")).toBe(buttonVariantClasses.danger);
    expect(buttonSizeClass("sm")).toBe(buttonSizeClasses.sm);
    expect(iconButtonSizeClass("sm")).toBe(iconButtonSizeClasses.sm);
  });
});
