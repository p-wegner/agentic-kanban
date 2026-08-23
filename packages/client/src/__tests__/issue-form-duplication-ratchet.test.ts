// @gate:always-run — recursively walks the client component tree; imports nothing it checks.
import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * The issue-form / workspace-launch duplication is a DOWN-only ring (#810, follow-up to #772).
 *
 * #732's `chart-duplication-ratchet.test.ts` pinned the chart family and nothing else, so the
 * OTHER half of that ticket's >= 50 %-duplicated list — the two create-issue forms, the edit
 * footer, the two workspace-launch surfaces and the workspace panel header — had no floor
 * under it. #772 collapsed what those six genuinely shared (`useIssueEnhance`,
 * `EnhanceActions`, `IssueFormFields`, `WorkspaceQuickLaunchMenu`) and #810 migrated the third
 * enhance copy in `useIssueEditForm` onto the hook; this is what stops any of it drifting back.
 *
 * The measurement is the SAME scanner as the chart ring — an exact 15-token window over
 * comment-stripped, string-normalised source, counted as the share of a file's windows that
 * also occur in some OTHER client file. Deliberately a heuristic net, not a proof: type-2
 * clones (same shape, renamed identifiers) are invisible to it. Kept local and duplicated
 * rather than shared with the chart ring on purpose — each ring must be re-derivable from the
 * repo alone by whoever it fails on, and a shared helper would let one ring's tuning silently
 * move the other's baseline.
 *
 * NOTE these percentages are NOT the ones quoted in #772's commit message. That commit
 * measured with a >= 60-SLOC floor and reported per-file ratios from its own run; the numbers
 * below were re-measured in this tree with the scanner in this file, which is the only measure
 * that can fail this suite. Baseline at what the gate measures, never at a quoted figure.
 */

/** Files the ring covers: #772's six, plus the four modules extracted out of them. */
const SCOPE = [
  // The six that #732 measured at >= 50 % and #772 addressed.
  "components/CreateIssueForm.tsx",
  "components/CreateIssuePanel.tsx",
  "components/IssueEditFooter.tsx",
  "components/WorkspaceEmptyState.tsx",
  "components/WorkspacePanelHeader.tsx",
  "components/WorkspaceQuickLaunch.tsx",
  // What came out of them — capped too, so the duplication cannot simply move sideways.
  "components/EnhanceActions.tsx",
  "components/IssueFormFields.tsx",
  "components/WorkspaceQuickLaunchMenu.tsx",
  "hooks/useIssueEnhance.ts",
];

/**
 * Highest tolerated share of a file's 15-token windows that also occur in ANOTHER file in the
 * client tree, as a percentage. Only ever LOWER a number — a raised one is the regression this
 * suite exists to catch.
 *
 * Each cap sits ~5 points above the measured value so an unrelated edit elsewhere in the
 * client (which can make a window newly shared) does not fail the gate spuriously.
 *
 * Two entries are deliberately NOT "well under 50 %", and saying so is the point of a ratchet
 * rather than a threshold:
 *  - `WorkspacePanelHeader.tsx` (62 %) is not a twin component — it is heroicons
 *    `<svg xmlns … stroke="currentColor" strokeWidth={2}><path strokeLinecap …>` boilerplate,
 *    which matches ~100 other client components at a 15-token window. Removing it needs the
 *    `<Icon>` primitive (#810 part 1), not a line-shave here.
 *  - `CreateIssuePanel.tsx` (50 %) is the slide-over shell. #772 checked and REFUTED the
 *    premise that it and `CreateIssueForm` are "the same form twice" — inline board card vs
 *    slide-over, ~9 mode flags apart, different submit payloads. Merging them is worse than
 *    the remaining duplication; their shared PARTS are already extracted. Do not re-attempt it.
 */
const MAX_DUP_PERCENT: Record<string, number> = {
  "components/CreateIssueForm.tsx": 40, // measured 35
  "components/CreateIssuePanel.tsx": 55, // measured 50
  "components/IssueEditFooter.tsx": 40, // measured 35
  "components/WorkspaceEmptyState.tsx": 44, // measured 39
  "components/WorkspacePanelHeader.tsx": 67, // measured 62 — see the <Icon> note above
  "components/WorkspaceQuickLaunch.tsx": 54, // measured 49
  "components/EnhanceActions.tsx": 32, // measured 27
  "components/IssueFormFields.tsx": 24, // measured 19
  "components/WorkspaceQuickLaunchMenu.tsx": 26, // measured 21
  "hooks/useIssueEnhance.ts": 19, // measured 14
};

/** Window length in tokens. 15 matches the chart ring, so the two measures are comparable. */
const WINDOW = 15;

const clientSrc = path.join(import.meta.dirname!, "..");
const rel = (f: string) => path.relative(clientSrc, f).split(path.sep).join("/");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "__tests__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Drop comment bodies so prose about the duplication does not count as duplication. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const TOKEN =
  /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|[A-Za-z_$][A-Za-z0-9_$]*|\d+(?:\.\d+)?|\S/g;

/**
 * Tokenise, collapsing every string literal to one `STR` token — so a shared 40-line Tailwind
 * class string counts as duplication even after one colour is changed. The measure is about
 * STRUCTURE, which matters more here than in the charts: these six differ mostly in sizing
 * classes and wording.
 */
function tokenize(text: string): string[] {
  const out: string[] = [];
  const src = stripComments(text);
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(src))) out.push(/^["'`]/.test(m[0]) ? "STR" : m[0]);
  return out;
}

function windowHashes(tokens: string[]): string[] {
  const hashes: string[] = [];
  for (let i = 0; i + WINDOW <= tokens.length; i++) {
    hashes.push(crypto.createHash("sha1").update(tokens.slice(i, i + WINDOW).join(" ")).digest("hex").slice(0, 16));
  }
  return hashes;
}

/** Percentage of each file's windows that also occur in some OTHER client file. */
function duplicationPercentByFile(): Record<string, number> {
  const files = walk(clientSrc);
  const hashesByFile = new Map<string, string[]>();
  const owners = new Map<string, Set<string>>();
  for (const file of files) {
    const hashes = windowHashes(tokenize(fs.readFileSync(file, "utf8")));
    const key = rel(file);
    hashesByFile.set(key, hashes);
    for (const h of new Set(hashes)) {
      let set = owners.get(h);
      if (!set) owners.set(h, (set = new Set()));
      set.add(key);
    }
  }
  const out: Record<string, number> = {};
  for (const [key, hashes] of hashesByFile) {
    if (hashes.length === 0) {
      out[key] = 0;
      continue;
    }
    let shared = 0;
    for (const h of hashes) {
      const set = owners.get(h)!;
      if (set.size > 1) shared++;
    }
    out[key] = Math.round((shared / hashes.length) * 100);
  }
  return out;
}

/** Scanning the whole client tree is I/O-bound; give it room under a loaded `test:mine`. */
const SCAN_TIMEOUT_MS = Number(process.env.VITEST_GUARD_SCAN_TIMEOUT) || 60_000;

describe("issue-form duplication is down-only (#810)", () => {
  const dup = duplicationPercentByFile();

  it("the scan reaches the client tree and every scoped file", () => {
    // A path typo or a rename would otherwise make every assertion below vacuously green.
    expect(Object.keys(dup).length).toBeGreaterThan(200);
    const missing = SCOPE.filter((f) => !(f in dup));
    expect(missing, `scoped file not found — rename it here too:\n${missing.join("\n")}`).toEqual([]);
  }, SCAN_TIMEOUT_MS);

  it("no issue-form module exceeds its duplication cap", () => {
    const over = SCOPE.filter((f) => dup[f] > MAX_DUP_PERCENT[f]).map(
      (f) => `${f}: ${dup[f]}% > cap ${MAX_DUP_PERCENT[f]}%`,
    );
    expect(
      over,
      "Duplication regrew in the issue-form / workspace-launch family. Import the shared piece\n" +
        "(useIssueEnhance / EnhanceActions / IssueFormFields / WorkspaceQuickLaunchMenu) or\n" +
        "extract a new one — do not copy a sibling component:\n" +
        over.join("\n"),
    ).toEqual([]);
  }, SCAN_TIMEOUT_MS);

  it("no cap is stale — the ring only ever shrinks", () => {
    // The half that makes this a ratchet rather than a budget: once a file improves, the cap
    // must follow it down, or the headroom silently becomes a licence to regress.
    const slack = SCOPE.filter((f) => MAX_DUP_PERCENT[f] - dup[f] > 12).map(
      (f) => `${f}: cap ${MAX_DUP_PERCENT[f]}%, actual ${dup[f]}% — lower the cap`,
    );
    expect(slack, slack.join("\n")).toEqual([]);
  }, SCAN_TIMEOUT_MS);

  it("no scoped file has climbed back to #732's 50% threshold, bar the two named exceptions", () => {
    // `CreateIssuePanel` sits exactly at 50 % and `WorkspacePanelHeader` above it, both for
    // reasons recorded on MAX_DUP_PERCENT. Everything else must stay clear of the line.
    const EXPECTED_AT_OR_OVER = ["components/CreateIssuePanel.tsx", "components/WorkspacePanelHeader.tsx"];
    const offenders = SCOPE.filter((f) => dup[f] >= 50 && !EXPECTED_AT_OR_OVER.includes(f)).map(
      (f) => `${f}: ${dup[f]}%`,
    );
    expect(offenders, offenders.join("\n")).toEqual([]);

    // And the exception list shrinks too: a file that drops below 50 % leaves it.
    const graduated = EXPECTED_AT_OR_OVER.filter((f) => dup[f] < 50);
    expect(
      graduated,
      "below 50% now — delete from EXPECTED_AT_OR_OVER:\n" + graduated.join("\n"),
    ).toEqual([]);
  }, SCAN_TIMEOUT_MS);
});

/**
 * The other half of "genuinely gone, not merely relocated": each extracted piece must exist in
 * exactly ONE module. A ratio cap alone cannot see a second copy that has drifted just enough
 * to fall under the window threshold — which is exactly how the enhance logic survived #772 a
 * third time inside `useIssueEditForm`.
 */
describe("the shared issue-form pieces are declared once (#810)", () => {
  const declarations: Record<string, string> = {
    useIssueEnhance: "hooks/useIssueEnhance.ts",
    EnhanceButton: "components/EnhanceActions.tsx",
    UndoEnhanceButton: "components/EnhanceActions.tsx",
    PastedImageStrip: "components/IssueFormFields.tsx",
    IssueTemplateSelect: "components/IssueFormFields.tsx",
    IssueTypeSelect: "components/IssueFormFields.tsx",
    IssueEstimateSelect: "components/IssueFormFields.tsx",
    SkillSelect: "components/IssueFormFields.tsx",
    AgentOptionCheckbox: "components/IssueFormFields.tsx",
    WorkspaceQuickLaunchMenu: "components/WorkspaceQuickLaunchMenu.tsx",
  };

  it("each shared symbol has exactly one declaring module", () => {
    const files = walk(clientSrc);
    const wrong: string[] = [];
    for (const [symbol, home] of Object.entries(declarations)) {
      const decl = new RegExp(`^export (?:function|const|interface) ${symbol}\\b`, "m");
      const declaring = files.filter((f) => decl.test(fs.readFileSync(f, "utf8"))).map(rel);
      if (declaring.length !== 1 || declaring[0] !== home) {
        wrong.push(`${symbol}: declared in [${declaring.join(", ")}], expected only ${home}`);
      }
    }
    expect(
      wrong,
      "A shared issue-form piece was re-declared or moved. Import it; do not copy it:\n" + wrong.join("\n"),
    ).toEqual([]);
  }, SCAN_TIMEOUT_MS);

  it("the enhance endpoint is called from exactly one module", () => {
    // The direct guard against a FOURTH copy of the behaviour #772 extracted and #810
    // finished migrating. The request is what every copy had in common; if a component calls
    // `/api/issues/enhance` itself, it has re-implemented the snapshot/undo bookkeeping too.
    const callers = walk(clientSrc)
      .filter((f) => fs.readFileSync(f, "utf8").includes("/api/issues/enhance"))
      .map(rel)
      .sort();
    expect(
      callers,
      "the enhance request belongs to hooks/useIssueEnhance.ts — use the hook (it returns\n" +
        "`enhancing`, `preEnhanceSnapshot`, `enhance`, `undoEnhance`, `clearSnapshot`)\n" +
        "instead of POSTing again:\n" + callers.join("\n"),
    ).toEqual(["hooks/useIssueEnhance.ts"]);
  }, SCAN_TIMEOUT_MS);
});
