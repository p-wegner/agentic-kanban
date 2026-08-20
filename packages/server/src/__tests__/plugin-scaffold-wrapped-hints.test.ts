import { describe, expect, it } from "vitest";
import { parseScaffoldFields, applyScaffoldValues } from "../services/plugin-scaffold.js";

/**
 * #439 — a `TODO:` hint that WRAPS onto a continuation line.
 *
 * The live instance: pm-pipeline's profile template wraps its "Input documents"
 * hint, so the filled `mealplan` profile ended up as
 *
 *   - **Input documents:** No payment, no account sharing, ...
 *     requirements, interface docs) the agents must ground on, or "none"
 *
 * i.e. template prose — with an unbalanced `)` — presented to every step agent as
 * the human's answer.
 *
 * The opposite failure is the dangerous one: over-consuming and swallowing the NEXT
 * bullet would silently delete a field the human filled in. Both directions are
 * pinned below.
 */

/** The real pm-pipeline template excerpt that produced the bug. */
const TEMPLATE = [
  "## Pipeline settings",
  "",
  "- **Artifact language:** TODO: language all generated documents are written in (e.g. English)",
  "- **Input documents:** TODO: repo-relative path to any existing source material (market reports,",
  "  requirements, interface docs) the agents must ground on, or \"none\"",
  "- **Tech direction (steps 5-8):** TODO: stack preferences, or \"agent's choice\"",
  "",
  "## Notes",
].join("\n");

describe("parseScaffoldFields — wrapped hints", () => {
  it("treats a wrapped hint as ONE field, not two", () => {
    const fields = parseScaffoldFields(TEMPLATE);
    expect(fields).toHaveLength(3);
  });

  it("joins the continuation into the label instead of truncating mid-sentence", () => {
    const [, inputDocs] = parseScaffoldFields(TEMPLATE);
    // The pre-fix label stopped at the line break, on a trailing comma.
    expect(inputDocs.label).not.toMatch(/,$/);
    expect(inputDocs.label).toContain("market reports");
    expect(inputDocs.label).toContain('or "none"');
    // Collapsed to a single line — this renders in a form label.
    expect(inputDocs.label).not.toContain("\n");
  });

  it("still reports the following bullet as its own field", () => {
    const fields = parseScaffoldFields(TEMPLATE);
    expect(fields[2].label).toContain("stack preferences");
  });
});

describe("applyScaffoldValues — wrapped hints", () => {
  it("consumes the continuation line so no template prose survives", () => {
    const { content } = applyScaffoldValues(TEMPLATE, [
      { index: 1, value: "none" },
    ]);
    expect(content).toContain("- **Input documents:** none");
    // The exact orphan seen live.
    expect(content).not.toContain("requirements, interface docs)");
  });

  it("does NOT swallow the next bullet — that would delete a field", () => {
    const { content } = applyScaffoldValues(TEMPLATE, [
      { index: 1, value: "none" },
    ]);
    expect(content).toContain("- **Tech direction (steps 5-8):** TODO:");
    expect(parseScaffoldFields(content)).toHaveLength(2);
  });

  it("leaves a blank line and the following heading intact", () => {
    const { content } = applyScaffoldValues(TEMPLATE, [{ index: 2, value: "TypeScript" }]);
    expect(content).toContain("## Notes");
    expect(content).toContain("- **Tech direction (steps 5-8):** TypeScript");
  });

  it("fills every field without leaving a placeholder behind", () => {
    const { content, remaining } = applyScaffoldValues(TEMPLATE, [
      { index: 0, value: "English" },
      { index: 1, value: "none" },
      { index: 2, value: "TypeScript" },
    ]);
    expect(remaining).toBe(0);
    expect(content).toContain("- **Artifact language:** English");
    expect(content).toContain("- **Input documents:** none");
    expect(content).toContain("- **Tech direction (steps 5-8):** TypeScript");
  });

  it("handles a hint wrapping over several lines", () => {
    const multi = [
      "- **A:** TODO: first line,",
      "  second line,",
      "  third line",
      "- **B:** TODO: other",
    ].join("\n");
    expect(parseScaffoldFields(multi)).toHaveLength(2);
    const { content } = applyScaffoldValues(multi, [{ index: 0, value: "x" }]);
    expect(content).toBe("- **A:** x\n- **B:** TODO: other");
  });

  it("stops at a continuation that is itself a TODO — never merges two fields", () => {
    const nested = ["- **A:** TODO: hint", "  TODO: sneaky second marker"].join("\n");
    expect(parseScaffoldFields(nested)).toHaveLength(2);
  });

  it("is unchanged for a hint on the last line with no trailing newline", () => {
    const { content, remaining } = applyScaffoldValues("- **A:** TODO: hint", [
      { index: 0, value: "done" },
    ]);
    expect(content).toBe("- **A:** done");
    expect(remaining).toBe(0);
  });
});
