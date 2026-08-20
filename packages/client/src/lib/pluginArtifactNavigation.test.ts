import { describe, it, expect } from "vitest";
import {
  detectGateBookkeeping,
  findMatchingLines,
  parseMarkdownOutline,
  segmentArtifact,
  slugifyHeading,
  splitHighlight,
} from "../components/PluginLoopExtras.js";
import { checkLocationTokens } from "./gateCardPolicy.js";

/**
 * #452 / #454 — the artifact viewer's navigation and gate-bookkeeping logic, unit-tested off
 * the live pm-pipeline shapes that motivated both tickets.
 */

const LIVE_STATUS_MD = [
  "# Step 7: Test & QA (plan + execution)",
  "",
  "Version: v1",
  "QA Execution: 42 automated, 0 manual, 8 unexecuted",
  "",
  "## Approval",
  "",
  "- [ ] Approved",
  "- [ ] Needs revision",
  "",
  "## Feedback",
  "",
  "(reviewer writes here)",
  "",
  "## Verification Report",
  "",
  "**Verdict:** PASS WITH FIXES",
  "STORY-2-1 Sz.3 is recorded auto while Finding F3 says not verifiable.",
  "",
].join("\n");

describe("parseMarkdownOutline", () => {
  it("lists headings with their line numbers", () => {
    const outline = parseMarkdownOutline(LIVE_STATUS_MD);
    expect(outline.map((h) => h.text)).toEqual([
      "Step 7: Test & QA (plan + execution)",
      "Approval",
      "Feedback",
      "Verification Report",
    ]);
    expect(outline[1]).toMatchObject({ depth: 2, line: 5, slug: "approval" });
  });

  it("ignores '#' inside fenced code", () => {
    const outline = parseMarkdownOutline("# Real\n\n```sh\n# not a heading\n```\n\n## Also real\n");
    expect(outline.map((h) => h.text)).toEqual(["Real", "Also real"]);
  });

  it("slugs are selector-safe", () => {
    expect(slugifyHeading("Step 7: Test & QA (plan + execution)")).toBe("step-7-test-qa-plan-execution");
    expect(slugifyHeading("***")).toBe("section");
  });
});

describe("findMatchingLines / splitHighlight", () => {
  it("finds the quoted identifier case-insensitively", () => {
    expect(findMatchingLines(LIVE_STATUS_MD, "story-2-1")).toEqual([17]);
    expect(findMatchingLines(LIVE_STATUS_MD, "nope")).toEqual([]);
    expect(findMatchingLines(LIVE_STATUS_MD, "   ")).toEqual([]);
  });

  it("splits a line into matched and unmatched runs", () => {
    expect(splitHighlight("a F3 b F3", "f3")).toEqual([
      { text: "a ", hit: false },
      { text: "F3", hit: true },
      { text: " b ", hit: false },
      { text: "F3", hit: true },
    ]);
    expect(splitHighlight("untouched", "")).toEqual([{ text: "untouched", hit: false }]);
  });
});

describe("detectGateBookkeeping", () => {
  it("finds the file-level approval block and folds in the placeholder feedback section", () => {
    const blocks = detectGateBookkeeping(LIVE_STATUS_MD, ["Approve", "Needs revision"]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      heading: "Approval",
      answered: false,
      feedbackHeading: "Feedback",
      startLine: 5,
    });
    expect(blocks[0].items.map((i) => i.label)).toEqual(["Approved", "Needs revision"]);
    // The fold must stop before the real content.
    expect(blocks[0].endLine).toBeLessThan(15);
  });

  it("reports an answered block as answered", () => {
    const answered = LIVE_STATUS_MD.replace("- [ ] Approved", "- [x] Approved");
    const blocks = detectGateBookkeeping(answered, ["Approve", "Needs revision"]);
    expect(blocks[0].answered).toBe(true);
  });

  it("falls back to a generic approval heading when no gate action labels are known", () => {
    const blocks = detectGateBookkeeping(LIVE_STATUS_MD);
    expect(blocks.map((b) => b.heading)).toEqual(["Approval"]);
  });

  it("leaves an ordinary checklist alone", () => {
    const md = "## Open questions\n\n- [ ] pick a database\n- [ ] confirm the pricing tier\n";
    expect(detectGateBookkeeping(md, ["Approve", "Needs revision"])).toEqual([]);
    expect(detectGateBookkeeping(md)).toEqual([]);
  });

  it("leaves a section that mixes prose with checkboxes alone", () => {
    const md = "## Approval\n\nSigned off by the product owner.\n\n- [ ] Approved\n- [ ] Needs revision\n";
    expect(detectGateBookkeeping(md)).toEqual([]);
  });

  it("does not fold in a Feedback section that holds real feedback", () => {
    const md = LIVE_STATUS_MD.replace("(reviewer writes here)", "Please re-run the STORY-2-1 scenario.");
    const blocks = detectGateBookkeeping(md, ["Approve", "Needs revision"]);
    expect(blocks[0].feedbackHeading).toBeUndefined();
  });
});

describe("segmentArtifact", () => {
  it("splits the document around the bookkeeping range and loses nothing else", () => {
    const blocks = detectGateBookkeeping(LIVE_STATUS_MD, ["Approve", "Needs revision"]);
    const segments = segmentArtifact(LIVE_STATUS_MD, blocks);
    expect(segments.map((s) => s.kind)).toEqual(["markdown", "bookkeeping", "markdown"]);
    expect(segments[0].text).toContain("# Step 7");
    expect(segments[1].text).toContain("- [ ] Approved");
    expect(segments[2].text).toContain("## Verification Report");
  });

  it("returns the document unchanged when nothing matched", () => {
    expect(segmentArtifact("# just a doc\n", [])).toEqual([{ kind: "markdown", text: "# just a doc\n" }]);
  });
});

describe("checkLocationTokens", () => {
  it("extracts the identifiers a live check detail quotes", () => {
    expect(checkLocationTokens('STORY-2-1 Sz.3 is recorded `auto` while Finding F3 says "not verifiable"'))
      .toEqual(["STORY-2-1", "F3"]);
  });

  it("keeps a backticked token only when it carries structure", () => {
    expect(checkLocationTokens("see `docs/pm-pipeline/steps/step-7/test_plan.md` and `auto`"))
      .toEqual(["docs/pm-pipeline/steps/step-7/test_plan.md"]);
  });

  it("is empty for a detail with nothing to jump to", () => {
    expect(checkLocationTokens("PASS WITH FIXES. Full report in status.")).toEqual([]);
    expect(checkLocationTokens(undefined)).toEqual([]);
  });
});
