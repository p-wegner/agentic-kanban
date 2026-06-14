import { describe, it, expect } from "vitest";
import { hasVisuallyVerifiableChanges } from "../startup/merge-workflow.js";

describe("hasVisuallyVerifiableChanges (#531 / Ktor UI verification)", () => {
  it("flags framework frontend files regardless of project type", () => {
    expect(hasVisuallyVerifiableChanges(["src/App.tsx"], false)).toBe(true);
    expect(hasVisuallyVerifiableChanges(["public/index.html"], false)).toBe(true);
    expect(hasVisuallyVerifiableChanges(["styles/main.css"], false)).toBe(true);
    expect(hasVisuallyVerifiableChanges(["game.js"], false)).toBe(true);
  });

  it("does NOT flag plain .ts (would tag every server change on a TS monorepo)", () => {
    expect(hasVisuallyVerifiableChanges(["packages/server/src/service.ts"], false)).toBe(false);
  });

  it("flags a .kt UI change ONLY for a web project (server-rendered Kotlin UI)", () => {
    const ktChange = ["src/main/kotlin/io/kanban/gallery/features/SignupForm.kt"];
    expect(hasVisuallyVerifiableChanges(ktChange, true)).toBe(true);   // Ktor/Spring web app → verify
    expect(hasVisuallyVerifiableChanges(ktChange, false)).toBe(false); // JVM library/CLI → don't over-tag
  });

  it("flags .java UI for a web project but not for a non-web one", () => {
    expect(hasVisuallyVerifiableChanges(["src/main/java/Page.java"], true)).toBe(true);
    expect(hasVisuallyVerifiableChanges(["src/main/java/Page.java"], false)).toBe(false);
  });

  it("returns false for an empty or non-UI change set", () => {
    expect(hasVisuallyVerifiableChanges([], true)).toBe(false);
    expect(hasVisuallyVerifiableChanges(["README.md", "build.gradle.kts"], true)).toBe(false);
  });
});
