// @gate:always-run when:CLAUDE.md,docs/agent-guide/** — reads CLAUDE.md and the agent-guide pages; imports nothing it checks.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * #1313 — root CLAUDE.md is loaded by every session, builders included, on every turn
 * (measured ~7.0k tokens, 17.0 KB). Operator/Conductor material was moved verbatim into
 * `docs/agent-guide/operator-reference.md`, so there is ONE copy of each rule and nothing to
 * keep in sync by hand. This guard keeps the split from drifting back:
 *  - root stays under a byte budget (a rise needs a deliberate edit of BUDGET_BYTES);
 *  - the operator-only headings live in the reference page and NOT in root;
 *  - root links the page, and the page still carries the sections root points at.
 */
const repoRoot = path.join(import.meta.dirname!, "..", "..", "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

/** ~10.1 KB today; 17.0 KB before the split. */
const BUDGET_BYTES = 11_500;

const OPERATOR_ONLY_HEADINGS = [
  "## Agent Roles",
  "## Skill Map",
  "## Workspace Flow",
  "## Agent Providers",
  "## Board Operations",
  "## Agent Skills",
];

describe("root CLAUDE.md builder budget (#1313)", () => {
  const root = read("CLAUDE.md");
  const reference = read("docs/agent-guide/operator-reference.md");

  it("stays under the byte budget", () => {
    const bytes = Buffer.byteLength(root, "utf8");
    expect(
      bytes,
      `CLAUDE.md is ${bytes} bytes (budget ${BUDGET_BYTES}). Every builder pays for it on every turn — ` +
        "put operator/Conductor material in docs/agent-guide/operator-reference.md instead.",
    ).toBeLessThanOrEqual(BUDGET_BYTES);
  });

  it("operator-only sections live in the reference page, not in root", () => {
    for (const heading of OPERATOR_ONLY_HEADINGS) {
      expect(root, `${heading} crept back into root CLAUDE.md`).not.toMatch(new RegExp(`^${heading}\\b`, "m"));
      expect(reference, `${heading} missing from operator-reference.md`).toMatch(new RegExp(`^${heading}\\b`, "m"));
    }
  });

  it("root links the reference page and the page exists", () => {
    expect(root).toContain("docs/agent-guide/operator-reference.md");
    expect(reference.length).toBeGreaterThan(1000);
  });

  it("the board-feedback modes stay documented in the reference page", () => {
    for (const mode of ["fix-direct", "file-ticket", "file-and-drive", "gh-issue"]) {
      expect(reference, `operator-reference.md no longer names ${mode}`).toContain(mode);
    }
  });
});
