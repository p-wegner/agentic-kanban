import { describe, expect, it } from "vitest";
import { buildGithubHandoffDraft } from "../services/github-handoff-draft.service.js";

describe("github-handoff-draft.service", () => {
  it("composes a markdown draft with issue, commits, files, verification, and reviewer notes", () => {
    const draft = buildGithubHandoffDraft({
      issue: { issueNumber: 217, title: "GitHub handoff draft", statusName: "Done" },
      workspace: {
        branch: "feature/ak-217-github-handoff",
        baseBranch: "main",
        mergedAt: "2026-06-01T10:00:00.000Z",
      },
      commits: [
        { sha: "abc1234", message: "feat: add GitHub draft export" },
        { sha: "def5678", message: "test: cover draft fallbacks" },
      ],
      changedFiles: [
        "packages/server/src/services/github-handoff-draft.service.ts",
        "packages/client/src/components/WorkspacePanel.tsx",
      ],
      testsRun: ["pnpm --filter agentic-kanban test -- github-handoff-draft.service.test.ts"],
      agentSummary: "Implemented a local markdown draft export.",
      reviewerNotes: ["WorkspacePanel.tsx: copy button should remain available after regeneration."],
    });

    expect(draft).toContain("# GitHub Handoff Draft: #217 GitHub handoff draft");
    expect(draft).toContain("- Status: Done");
    expect(draft).toContain("- Branch: `feature/ak-217-github-handoff`");
    expect(draft).toContain("- `abc1234` feat: add GitHub draft export");
    expect(draft).toContain("- `packages/client/src/components/WorkspacePanel.tsx`");
    expect(draft).toContain("- `pnpm --filter agentic-kanban test -- github-handoff-draft.service.test.ts`");
    expect(draft).toContain("## Reviewer Notes");
    expect(draft).toContain("copy button should remain available");
  });

  it("uses clear fallbacks when optional draft fields are missing", () => {
    const draft = buildGithubHandoffDraft({
      issue: { title: "Untitled local task" },
      workspace: { branch: "feature/no-extra-data" },
    });

    expect(draft).toContain("# GitHub Handoff Draft: Untitled local task");
    expect(draft).toContain("## Summary\n- Not recorded.");
    expect(draft).toContain("- Branch: `feature/no-extra-data`");
    expect(draft).toContain("- No commits recorded.");
    expect(draft).toContain("- No changed files recorded.");
    expect(draft).toContain("## Verification\n- Not recorded.");
    expect(draft).not.toContain("## Reviewer Notes");
  });
});
