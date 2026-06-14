import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { wrongCheckoutVitestReason } = require("../../../../.claude/hooks/smart-hooks-runner.js") as {
  wrongCheckoutVitestReason: (input: unknown, command: string) => string | null;
};

describe("smart-hooks-runner wrong-checkout vitest guard", () => {
  it("blocks test:mine from the main checkout when the session belongs to a worktree", () => {
    const reason = wrongCheckoutVitestReason(
      {
        tool_name: "PowerShell",
        cwd: "C:/andrena/agentic-kanban",
        transcript_path: "C:/Users/pwegner/.claude/projects/C--andrena--.worktrees--feature_ak-123/foo.jsonl",
      },
      "pnpm test:mine -- --changed HEAD",
    );

    expect(reason).toContain("Run worktree tests from the worktree root");
    expect(reason).toContain("pnpm test:mine -- --changed HEAD");
  });

  it("blocks explicit cd into the main checkout before vitest", () => {
    const reason = wrongCheckoutVitestReason(
      {
        tool_name: "Bash",
        cwd: "C:/andrena/.worktrees/feature_ak-123",
        transcript_path: "C:/Users/pwegner/.claude/projects/C--andrena--.worktrees--feature_ak-123/foo.jsonl",
      },
      "cd C:/andrena/agentic-kanban && pnpm exec vitest packages/server/src/foo.test.ts",
    );

    expect(reason).toContain("main checkout");
  });

  it("allows vitest commands from the worktree", () => {
    const reason = wrongCheckoutVitestReason(
      {
        tool_name: "PowerShell",
        cwd: "C:/andrena/.worktrees/feature_ak-123/packages/server",
        transcript_path: "C:/Users/pwegner/.claude/projects/C--andrena--.worktrees--feature_ak-123/foo.jsonl",
      },
      "pnpm exec vitest related src/foo.test.ts",
    );

    expect(reason).toBeNull();
  });
});
