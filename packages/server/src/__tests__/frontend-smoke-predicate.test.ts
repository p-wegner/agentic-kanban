import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  convertToSmokeText,
  formatSmokeSnippet,
  isSmokeSuccess,
  SMOKE_SUCCESS_PATTERN,
} = require("../../../../scripts/board-monitor/frontend-smoke-predicate.js") as {
  convertToSmokeText: (value: unknown) => string;
  formatSmokeSnippet: (value: unknown, maxLength?: number) => string;
  isSmokeSuccess: (value: unknown) => boolean;
  SMOKE_SUCCESS_PATTERN: RegExp;
};

describe("frontend-smoke predicate — success states", () => {
  it('succeeds when rendered text contains column header "Backlog"', () => {
    expect(isSmokeSuccess("Backlog\nTodo\nIn Progress")).toBe(true);
  });

  it('succeeds when rendered text contains column header "Todo"', () => {
    expect(isSmokeSuccess("Todo")).toBe(true);
  });

  it('succeeds when rendered text contains column header "In Progress"', () => {
    expect(isSmokeSuccess("In Progress")).toBe(true);
  });

  it('succeeds when rendered text contains empty-column placeholder "No issues"', () => {
    expect(isSmokeSuccess("Backlog\nNo issues\nTodo\nNo issues")).toBe(true);
  });

  it('succeeds when rendered text contains "No projects registered" (no-project fallback)', () => {
    expect(isSmokeSuccess("No projects registered")).toBe(true);
  });

  it("succeeds when innerText is an array of strings (hydrated board stats shape)", () => {
    // Playwright may return innerText as an array when evaluated over multiple nodes.
    // A hydrated board will contain column headers among the array entries.
    const hydrated = ["Backlog", "3", "Todo", "1", "In Progress", "2", "No issues"];
    expect(isSmokeSuccess(hydrated)).toBe(true);
  });

  it("succeeds when array contains only empty-column placeholders mixed with headers", () => {
    const partiallyEmpty = ["Todo", "No issues", "In Progress", "No issues"];
    expect(isSmokeSuccess(partiallyEmpty)).toBe(true);
  });

  it("succeeds when rendered text contains stats bar numbers alongside column names", () => {
    const withStats = "Backlog\n5 issues\n2 workspaces\nTodo\nIn Progress";
    expect(isSmokeSuccess(withStats)).toBe(true);
  });
});

describe("frontend-smoke predicate — failure states", () => {
  it("fails on empty string (blank page or white screen)", () => {
    expect(isSmokeSuccess("")).toBe(false);
  });

  it("fails on null (document.querySelector returned nothing)", () => {
    expect(isSmokeSuccess(null)).toBe(false);
  });

  it("fails on undefined (eval call returned no value)", () => {
    expect(isSmokeSuccess(undefined)).toBe(false);
  });

  it("fails on Vite error HTML that contains no board content", () => {
    const viteError =
      '<div id="vite-error-overlay">' +
      "<h1>Failed to compile</h1>" +
      "<p>Cannot find module './board'</p>" +
      "</div>";
    expect(isSmokeSuccess(viteError)).toBe(false);
  });

  it("fails on loading spinner / skeleton text with no board content", () => {
    expect(isSmokeSuccess("Loading…")).toBe(false);
  });

  it("fails on an empty root element (React mounted but rendered nothing)", () => {
    expect(isSmokeSuccess('<div id="root"></div>')).toBe(false);
  });

  it("fails on irrelevant static text that does not match any board signal", () => {
    expect(isSmokeSuccess("Welcome to the app")).toBe(false);
  });

  it("fails on an empty array (Playwright returned no text nodes)", () => {
    expect(isSmokeSuccess([])).toBe(false);
  });

  it("fails on array of empty strings", () => {
    expect(isSmokeSuccess(["", "", ""])).toBe(false);
  });

  it("fails on array with only whitespace and punctuation", () => {
    expect(isSmokeSuccess(["·", "—", " "])).toBe(false);
  });
});

describe("convertToSmokeText — normalisation", () => {
  it("returns empty string for null", () => {
    expect(convertToSmokeText(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(convertToSmokeText(undefined)).toBe("");
  });

  it("returns the string itself for a plain string", () => {
    expect(convertToSmokeText("Todo")).toBe("Todo");
  });

  it("joins array entries with newline", () => {
    expect(convertToSmokeText(["Todo", "In Progress"])).toBe(
      "Todo\nIn Progress"
    );
  });

  it("coerces null array entries to empty strings", () => {
    expect(convertToSmokeText(["Todo", null, "In Progress"])).toBe(
      "Todo\n\nIn Progress"
    );
  });

  it("coerces non-string primitives to strings", () => {
    expect(convertToSmokeText(42)).toBe("42");
  });
});

describe("formatSmokeSnippet — truncation", () => {
  it("returns at most maxLength characters", () => {
    const snippet = formatSmokeSnippet("Todo\nIn Progress\nBacklog", 10);
    expect(snippet.length).toBeLessThanOrEqual(10);
  });

  it("returns the full text when it is shorter than maxLength", () => {
    const snippet = formatSmokeSnippet("Todo", 500);
    expect(snippet).toBe("Todo");
  });

  it("handles null with any maxLength without throwing", () => {
    expect(() => formatSmokeSnippet(null, 12)).not.toThrow();
    expect(formatSmokeSnippet(null, 12)).toBe("");
  });

  it("treats negative maxLength as zero (returns empty string)", () => {
    expect(formatSmokeSnippet("Todo", -1)).toBe("");
  });

  it("reproduces what the old direct Substring call on an array would fail on", () => {
    // The original PowerShell smoke check used $text.Substring(0, ...) directly on
    // whatever Playwright returned.  When the page was hydrated, Playwright returned
    // an array, and calling .Substring on an array throws.  convertToSmokeText must
    // join the array first so formatSmokeSnippet never receives a raw array.
    const hydrated = ["Backlog", "Todo", "In Progress", "No issues", "x", "y"];
    const snippet = formatSmokeSnippet(hydrated, 500);
    expect(snippet).toContain("Backlog");
    expect(snippet).toContain("In Progress");
  });
});

describe("SMOKE_SUCCESS_PATTERN — direct regex contract", () => {
  it("matches 'Backlog'", () => {
    expect(SMOKE_SUCCESS_PATTERN.test("Backlog")).toBe(true);
  });

  it("matches 'Todo'", () => {
    expect(SMOKE_SUCCESS_PATTERN.test("Todo")).toBe(true);
  });

  it("matches 'In Progress'", () => {
    expect(SMOKE_SUCCESS_PATTERN.test("In Progress")).toBe(true);
  });

  it("matches 'No issues'", () => {
    expect(SMOKE_SUCCESS_PATTERN.test("No issues")).toBe(true);
  });

  it("matches 'No projects registered'", () => {
    expect(SMOKE_SUCCESS_PATTERN.test("No projects registered")).toBe(true);
  });

  it("does not match arbitrary text", () => {
    expect(SMOKE_SUCCESS_PATTERN.test("Hello world")).toBe(false);
  });
});
