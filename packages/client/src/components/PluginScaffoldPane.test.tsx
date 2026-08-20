import { describe, expect, it } from "vitest";
import { deriveProductIdentity } from "./PluginScaffoldPane.js";

const MEALPLAN_PROFILE = `# PM Pipeline — Project Profile

This file scopes the whole pipeline. Every step's agent reads it first.

## Product

- **Name:** MealPlan
- **One-line pitch:** A weekly meal planner for busy households.
- **Vision:** Households waste food and money because meals are decided ad hoc.
`;

describe("deriveProductIdentity (#455)", () => {
  it("reads name and pitch out of the scaffolded profile", () => {
    const identity = deriveProductIdentity(MEALPLAN_PROFILE);
    expect(identity).toEqual({
      name: "MealPlan",
      pitch: "A weekly meal planner for busy households.",
      oneLiner: "MealPlan: A weekly meal planner for busy households.",
    });
  });

  it("falls back to whichever half the profile states", () => {
    expect(deriveProductIdentity("- **Name:** Solo\n")).toMatchObject({ pitch: null, oneLiner: "Solo" });
    expect(deriveProductIdentity("**Pitch**: Just a pitch\n")).toMatchObject({
      name: null,
      oneLiner: "Just a pitch",
    });
  });

  it("treats an unfilled TODO marker as absent, not as the product name", () => {
    // The setup gate (#291) is exactly the state where the value is still a marker;
    // rendering "TODO: the product name" as the heading would be worse than nothing.
    expect(deriveProductIdentity("- **Name:** TODO: fill this in\n")).toBeNull();
  });

  it("returns null when there is nothing to say", () => {
    expect(deriveProductIdentity(null)).toBeNull();
    expect(deriveProductIdentity("")).toBeNull();
    expect(deriveProductIdentity("# Heading\n\nSome prose with no labelled fields.\n")).toBeNull();
  });

  it("ignores unrelated labelled lines", () => {
    const identity = deriveProductIdentity(
      "- **Target group:** Home cooks\n- **Name:** MealPlan\n- **Business model:** none\n",
    );
    expect(identity?.name).toBe("MealPlan");
    expect(identity?.pitch).toBeNull();
  });
});
