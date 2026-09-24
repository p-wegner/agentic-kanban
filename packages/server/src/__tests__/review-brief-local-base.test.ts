import { describe, it, expect } from "vitest";
import { buildReviewPrompt } from "../services/review.service.js";
import { createTestDb } from "./helpers/test-db.js";

/**
 * #1237 — the review brief names the LOCAL base branch, never `origin/<base>`.
 *
 * Merges land locally in this board's model, so a remote may not exist, may be renamed, or may
 * be days stale. On 2026-09-24 the brief said "Start a fresh rebase: `git rebase origin/master`";
 * origin/master was five days behind (nothing pushes master), the reviewer replayed 112 commits
 * onto it and then force-moved the shared master back to that ref. The brief is rendered here
 * for a project WITHOUT a remote (base "master") and for one whose caller hands in the
 * remote-tracking spelling ("origin/master"), in both conflict preambles, and must never name
 * `origin/` in either.
 */
describe("review brief names the local base, never origin/<base> (#1237)", () => {
  const render = (baseBranch: string, kind: "conflicts" | "uncommitted") =>
    buildReviewPrompt(
      createTestDb().db,
      "feature/ak-1228",
      baseBranch,
      "issue-1228",
      true,
      undefined,
      kind === "conflicts" ? ["packages/server/src/a.ts"] : undefined,
      kind === "uncommitted" ? [" M packages/server/src/a.ts"] : undefined,
      "ws-1228",
      "code-review",
      "none",
      null,
    );

  for (const baseBranch of ["master", "origin/master"]) {
    for (const kind of ["conflicts", "uncommitted"] as const) {
      it(`base "${baseBranch}", ${kind} preamble: instructs \`git rebase master\` and never names origin/`, async () => {
        const { prompt } = await render(baseBranch, kind);
        expect(prompt).toContain("git rebase master");
        expect(prompt).not.toContain("origin/");
      });
    }
  }

  it("the conflict brief also says never to move the base itself", async () => {
    const { prompt } = await render("master", "conflicts");
    expect(prompt).toMatch(/never move master itself/);
  });

  it("a clean brief (no preamble) names no origin/ either", async () => {
    const { prompt } = await buildReviewPrompt(
      createTestDb().db, "feature/ak-1228", "origin/master", "issue-1228", true,
      undefined, undefined, undefined, "ws-1228", "code-review", "none", null,
    );
    expect(prompt).not.toContain("origin/");
  });
});
