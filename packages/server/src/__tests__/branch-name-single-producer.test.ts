import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { suggestBranchName } from "@agentic-kanban/shared/lib/branch";

/**
 * #220 — branch-name PRODUCER agreement.
 *
 * The bug: on 2026-08-02 a workspace created explicitly via `POST /api/workspaces`
 * and a second one auto-started by the monitor 41 seconds later carried DIFFERENT
 * branch slugs for the SAME issue, so the duplicate-start guard (which keyed on
 * the derived branch name) did not see the first workspace and two agents worked
 * the same ticket in two worktrees.
 *
 * Ask 1 (key the guard on `issueId`, never on a derived string) landed with #366.
 * This file covers ask 2: `suggestBranchName` is the ONE producer, and every
 * caller uses it.
 *
 * The existing #366 coverage only tested `suggestBranchName` itself, so it could
 * not have failed while three OTHER sites hand-rolled their own derivation:
 *   - `cli/commands/workspace.ts`             `workspace/${issueId.slice(0,8)}`
 *   - `mcp-server/tools/start-workspace.ts`   `workspace/${issueId.slice(0,8)}`
 *   - `services/followup-workspace.service.ts` a near-copy that sliced the slug at
 *     50 chars instead of 40 and skipped the `-+ -> -` collapse.
 *
 * Two gates below, because they fail for different reasons:
 *  (1) a BEHAVIOURAL check that the divergences the ticket describes really do
 *      diverge — so the reader can see what the gate is protecting against, and
 *      the fixture is the ticket's own ready-made title;
 *  (2) a STRUCTURAL scan of the three fixed call sites. This is honestly a gate on
 *      the code's shape, not on runtime behaviour: the derivations are inline in
 *      command handlers with no seam to call, so there is nothing to invoke. It
 *      would still go red the moment one of them reintroduces a private
 *      derivation, which is the regression that actually happened.
 */

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../../..");

/** The ticket's ready-made fixture: a hyphenated word AND an apostrophe-s boundary. */
const FIXTURE = {
  issueNumber: 176,
  title: "#176 follow-up: simplify updateBase's leading-seeded aggregation loop",
};

/** The `followup-workspace.service.ts` derivation as it stood before this fix. */
function legacyFollowupDerivation(issue: { issueNumber?: number | null; title: string }): string {
  const sanitized = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return `feature/ak-${issue.issueNumber ?? "f"}-${sanitized}`;
}

describe("#220 — one branch-name producer", () => {
  it("the removed follow-up derivation really did disagree with suggestBranchName", () => {
    // Not a tautology: this is the concrete divergence, on the ticket's own fixture.
    // 40-char slice vs 50-char slice is enough to mint a second branch for one issue.
    expect(suggestBranchName(FIXTURE)).toBe("feature/ak-176-176-follow-up-simplify-updatebase-s-lead");
    expect(legacyFollowupDerivation(FIXTURE)).toBe(
      "feature/ak-176-176-follow-up-simplify-updatebase-s-leading-seeded",
    );
    expect(legacyFollowupDerivation(FIXTURE)).not.toBe(suggestBranchName(FIXTURE));
  });

  it("suggestBranchName collapses runs and trims, so one issue has exactly one name", () => {
    // Idempotent for the same input, and never leaves a trailing/doubled separator —
    // the two properties a guard keyed on the name would depend on.
    const name = suggestBranchName(FIXTURE);
    expect(name).toBe(suggestBranchName({ ...FIXTURE }));
    expect(name).not.toMatch(/--/);
    expect(name).not.toMatch(/-$/);
    expect(name.startsWith("feature/ak-176-")).toBe(true);
  });

  const CALL_SITES = [
    join("packages", "server", "src", "cli", "commands", "workspace.ts"),
    join("packages", "mcp-server", "src", "tools", "start-workspace.ts"),
    join("packages", "server", "src", "services", "followup-workspace.service.ts"),
  ];

  it.each(CALL_SITES)("%s derives its branch from suggestBranchName", (relPath) => {
    const src = readFileSync(join(REPO_ROOT, relPath), "utf8");
    expect(src).toContain("suggestBranchName");
    // Strip comments before scanning: the fix's own comments quote the old shapes.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    // The divergent CONVENTION (`workspace/<id8>`), not merely a divergent slug.
    expect(code).not.toMatch(/`workspace\/\$\{/);
    // A hand-rolled `feature/ak-...` template is the other shape that drifted.
    expect(code).not.toMatch(/`feature\/ak-\$\{/);
  });
});
