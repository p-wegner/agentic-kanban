import { describe, it, expect } from "vitest";
import {
  buildAgentPrompt,
  neutralizeBuildTimeVisualVerification,
  isBuildTimeVisualVerificationInstruction,
} from "../services/workspace-create/policy.js";

describe("workspace-create policy: isBuildTimeVisualVerificationInstruction", () => {
  // The hard-won lesson: a Codex builder that reads "install playwright / visually
  // verify" hangs forever on `npx playwright install`. These MUST be stripped.
  it.each([
    "Run npx playwright install chromium before testing",
    "playwright install",
    "Install the browser runtime to take screenshots",
    "Use playwright-cli to verify",
    "Attach a screenshot as proof before finishing",
    "Take a screenshot showing it working after completing the change",
    "You must visually verify the page renders",
    "Before review, perform visual verification of the UI",
  ])("flags build-time visual/install instruction: %s", (line) => {
    expect(isBuildTimeVisualVerificationInstruction(line)).toBe(true);
  });

  // Genuine PRODUCT requirements must NOT be stripped — they describe the feature.
  it.each([
    "Add a button that uploads an image attachment",
    "Implement a screenshot capture component for users",
    "Render the canvas and let the customer download a screenshot",
    "Create an endpoint that saves the uploaded image",
    "",
    "Fix the off-by-one in the date parser",
  ])("keeps genuine product requirement / unrelated line: %s", (line) => {
    expect(isBuildTimeVisualVerificationInstruction(line)).toBe(false);
  });
});

describe("workspace-create policy: neutralizeBuildTimeVisualVerification", () => {
  it("removes only the offending lines and collapses blank runs", () => {
    const prompt = [
      "Implement the export button.",
      "",
      "Run npx playwright install and take a screenshot as proof before finishing.",
      "",
      "Save the file to disk.",
    ].join("\n");
    const out = neutralizeBuildTimeVisualVerification(prompt);
    expect(out).not.toMatch(/playwright install/i);
    expect(out).not.toMatch(/screenshot as proof/i);
    expect(out).toContain("Implement the export button.");
    expect(out).toContain("Save the file to disk.");
    expect(out).not.toMatch(/\n{3,}/);
  });

  it("returns the prompt unchanged when there is nothing to strip", () => {
    const prompt = "Add a /health route\n\nReturn 200 OK.";
    expect(neutralizeBuildTimeVisualVerification(prompt)).toBe(prompt);
  });
});

describe("workspace-create policy: buildAgentPrompt", () => {
  it("composes title + description", () => {
    const out = buildAgentPrompt({ title: "Fix bug", description: "in the parser" }, {});
    expect(out).toBe("Fix bug\n\nin the parser");
  });

  it("prefers a customPrompt over the issue text", () => {
    const out = buildAgentPrompt({ title: "T", description: "D" }, { customPrompt: "do exactly this" });
    expect(out).toBe("do exactly this");
  });

  it("prepends answered clarifications", () => {
    const out = buildAgentPrompt({ title: "T", description: null }, { clarifications: "Q: scope? A: small" });
    expect(out).toBe("Q: scope? A: small\n\nT");
  });

  it("neutralizes a leading slash so Claude does not treat it as a slash command", () => {
    const out = buildAgentPrompt({ title: "/merge endpoint refactor", description: null }, {});
    expect(out.startsWith(" /merge")).toBe(true);
  });

  it("strips build-time visual verification from the issue text and appends the board-owned notice when includeVisualProof", () => {
    const out = buildAgentPrompt(
      { title: "Add chart", description: "Run npx playwright install and attach a screenshot as proof before finishing." },
      { includeVisualProof: true },
    );
    expect(out).not.toMatch(/playwright install/i);
    expect(out).toContain("Board-Owned Visual Verification");
  });
});
