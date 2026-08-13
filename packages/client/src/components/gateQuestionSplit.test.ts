import { describe, expect, it } from "vitest";
import { splitGateQuestion } from "./PluginLoopExtras.js";

/**
 * A gate question frequently repeats, in truncated form, the very failure its checks
 * already spell out in full. The card then printed the same sentence twice and pushed the
 * butler verdict and the action buttons below the fold — which is the real cost, since the
 * reader has to scroll past a duplicate paragraph to reach the decision.
 *
 * The rule must stay plugin-agnostic: never parse a plugin's question format, just refuse to
 * print a sentence a check already carries.
 */

const PMQA_QUESTION =
  'Approve step 7/9 — Test & QA (plan + execution) (v3)? ⚠ 1 record row(s) claim verification '
  + 'for a criterion the Findings declare unverifiable: STORY-3-1 Sz.1 is recorded `manual` '
  + 'while Finding F1 says "cannot be verif".';

const PMQA_CHECK_DETAIL =
  '⚠ 1 record row(s) claim verification for a criterion the Findings declare unverifiable: '
  + 'STORY-3-1 Sz.1 is recorded `manual` while Finding F1 says "cannot be verif". Either the row '
  + 'is `unexecuted` (with the finding as its reason) or the finding overstates — the document '
  + 'disagrees with itself and a human has to decide which half is right. This does NOT change '
  + 'the unexecuted count.';

describe("splitGateQuestion", () => {
  it("drops the trailing detail when a check already carries it (the live pmqa gate)", () => {
    const res = splitGateQuestion(PMQA_QUESTION, [
      { detail: "Inline verification of Test & QA v3: PASS." },
      { detail: PMQA_CHECK_DETAIL },
    ]);
    expect(res.heading).toBe("Approve step 7/9 — Test & QA (plan + execution) (v3)?");
    expect(res.duplicatedDetail).toContain("1 record row(s) claim verification");
    // The heading must not still contain the duplicated sentence.
    expect(res.heading).not.toContain("record row(s)");
  });

  it("matches despite the question TRUNCATING the check's sentence", () => {
    // The question ends mid-word ("cannot be verif"); the check has the full text. A
    // whole-string comparison would miss this — the prefix probe is what makes it work.
    const res = splitGateQuestion(PMQA_QUESTION, [{ detail: PMQA_CHECK_DETAIL }]);
    expect(res.duplicatedDetail).not.toBeNull();
  });

  it("keeps the full question when NO check echoes it", () => {
    const res = splitGateQuestion(PMQA_QUESTION, [{ detail: "Something entirely unrelated" }]);
    expect(res.heading).toBe(PMQA_QUESTION);
    expect(res.duplicatedDetail).toBeNull();
  });

  it("keeps the full question when there are no checks at all", () => {
    for (const checks of [undefined, null, []]) {
      const res = splitGateQuestion(PMQA_QUESTION, checks);
      expect(res.heading).toBe(PMQA_QUESTION);
      expect(res.duplicatedDetail).toBeNull();
    }
  });

  it("leaves a plain question untouched", () => {
    const res = splitGateQuestion("Approve step 3/9 — Roadmap & Epics (v1)?", [
      { detail: "All checks passed." },
    ]);
    expect(res.heading).toBe("Approve step 3/9 — Roadmap & Epics (v1)?");
    expect(res.duplicatedDetail).toBeNull();
  });

  it("leaves a question with no question mark untouched", () => {
    const q = "Review the generated roadmap before the next step unlocks";
    expect(splitGateQuestion(q, [{ detail: q }]).heading).toBe(q);
  });

  it("does not strip a SHORT trailing fragment that could collide by accident", () => {
    // Below the 20-char probe floor: too weak a signal to act on.
    const q = "Approve it? Yes";
    expect(splitGateQuestion(q, [{ detail: "Yes" }]).heading).toBe(q);
  });

  it("tolerates checks with null or missing details", () => {
    const res = splitGateQuestion(PMQA_QUESTION, [{ detail: null }, {}, { detail: PMQA_CHECK_DETAIL }]);
    expect(res.duplicatedDetail).not.toBeNull();
  });
});

/**
 * #449 — the MEASURED two-tail bug. The live `mealplan` step-7 question carried TWO appended
 * ⚠ segments. The whole-tail probe was their CONCATENATION, which matches no single check, so
 * the dedupe silently declined and the finding was printed twice. It failed toward "print it
 * twice" — the exact state this function exists to prevent — and it failed invisibly.
 */
const UNEXECUTED_TAIL =
  '8 of 50 acceptance criteria are UNEXECUTED — approving waives them and needs a written reason.';
const CLASSIFICATION_TAIL =
  '1 record row(s) claim verification for a criterion the Findings declare unverifiable: '
  + 'STORY-2-1 Sz.3 is recorded `auto` while Finding F3 says "not verifiable".';
const TWO_TAIL_QUESTION =
  `Approve step 7/9 — Test & QA (plan + execution) (v1)? ⚠ ${UNEXECUTED_TAIL} ⚠ ${CLASSIFICATION_TAIL}`;

const UNEXECUTED_CHECK =
  `⚠ ${UNEXECUTED_TAIL} The plan lists them but the record shows no run — a human decides whether `
  + 'that is acceptable for this milestone.';
const CLASSIFICATION_CHECK =
  `⚠ ${CLASSIFICATION_TAIL} Either the row is \`unexecuted\` (with the finding as its reason) or `
  + 'the finding overstates — the document disagrees with itself.';

describe("#449 — a question with TWO ⚠ tails is deduped segment by segment", () => {
  it("drops both segments when both are echoed by checks", () => {
    const res = splitGateQuestion(TWO_TAIL_QUESTION, [
      { detail: UNEXECUTED_CHECK },
      { detail: CLASSIFICATION_CHECK },
    ]);
    expect(res.heading).toBe("Approve step 7/9 — Test & QA (plan + execution) (v1)?");
    expect(res.heading).not.toContain("UNEXECUTED");
    expect(res.heading).not.toContain("record row(s)");
    expect(res.keptDetails).toEqual([]);
    expect(res.duplicatedDetail).toContain("UNEXECUTED");
    expect(res.duplicatedDetail).toContain("record row(s)");
  });

  it("drops only the echoed segment and KEEPS the one no check carries", () => {
    const res = splitGateQuestion(TWO_TAIL_QUESTION, [{ detail: CLASSIFICATION_CHECK }]);
    expect(res.heading).toBe("Approve step 7/9 — Test & QA (plan + execution) (v1)?");
    // The classification sentence is already on a check — not printed a second time.
    expect(res.duplicatedDetail).toContain("record row(s)");
    // The unexecuted-criteria finding is on NO check, so it must survive as a finding of its own
    // rather than being swallowed with its neighbour.
    expect(res.keptDetails).toEqual([UNEXECUTED_TAIL]);
    expect(res.heading).not.toContain("UNEXECUTED");
  });

  it("keeps the whole question verbatim when neither segment is echoed", () => {
    const res = splitGateQuestion(TWO_TAIL_QUESTION, [{ detail: "Inline verification: PASS." }]);
    expect(res.heading).toBe(TWO_TAIL_QUESTION);
    expect(res.duplicatedDetail).toBeNull();
    expect(res.keptDetails).toEqual([]);
  });

  it("still handles the single-tail question exactly as before (no regression)", () => {
    const res = splitGateQuestion(PMQA_QUESTION, [{ detail: PMQA_CHECK_DETAIL }]);
    expect(res.heading).toBe("Approve step 7/9 — Test & QA (plan + execution) (v3)?");
    expect(res.keptDetails).toEqual([]);
  });

  it("reports no kept details for a question with no tail at all", () => {
    const res = splitGateQuestion("Approve step 3/9 — Roadmap & Epics (v1)?", [{ detail: "All checks passed." }]);
    expect(res.keptDetails).toEqual([]);
    expect(res.duplicatedDetail).toBeNull();
  });
});
