import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTicketContextMarkdown } from "@agentic-kanban/shared/lib/ticket-context";
import { buildAgentPrompt, buildGroupPromptSection } from "../services/workspace-create/policy.js";
import { resolveEffectivePrompt } from "../services/agent-provider/context-files-prompt.js";

const DESC = "UNIQUE-SPEC-MARKER: rewrite the frobnicator so it frobs twice.";
const MEMBER = "UNIQUE-MEMBER-MARKER: second ticket body.";
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

function fileWith(md: string): string {
  const p = join(mkdtempSync(join(tmpdir(), "tc-")), "CLAUDE.local.md");
  writeFileSync(p, md);
  return p;
}

describe("ticket description is carried by one channel (#1762)", () => {
  const issue = { title: "T", description: DESC };
  const members = [{ issueNumber: 2, title: "M", description: MEMBER }];

  it("claude: prompt + file hold the description once", () => {
    const prompt = buildAgentPrompt(issue, {}) + `\n\n${buildGroupPromptSection(members)}`;
    const md = buildTicketContextMarkdown({
      issueNumber: 1, title: "T", description: DESC, groupTickets: members,
      descriptionInPrompt: true, groupDescriptionsInPrompt: true,
    });
    const payload = resolveEffectivePrompt(prompt, "claude", [fileWith(md)]) + md;
    expect(count(payload, DESC)).toBe(1);
    expect(count(payload, MEMBER)).toBe(1);
  });

  it("codex: prompt + appended file hold the description once, even from an un-deduped file", () => {
    const prompt = buildAgentPrompt(issue, {}) + `\n\n${buildGroupPromptSection(members)}`;
    const md = buildTicketContextMarkdown({ issueNumber: 1, title: "T", description: DESC });
    const payload = resolveEffectivePrompt(prompt, "codex", [fileWith(md)]);
    expect(count(payload, DESC)).toBe(1);
    const flagged = buildTicketContextMarkdown({ issueNumber: 1, title: "T", description: DESC, descriptionInPrompt: true });
    expect(count(resolveEffectivePrompt(prompt, "codex", [fileWith(flagged)]), DESC)).toBe(1);
  });

  it("a custom prompt keeps the description in the file", () => {
    const md = buildTicketContextMarkdown({ issueNumber: 1, title: "T", description: DESC });
    const payload = resolveEffectivePrompt("custom", "codex", [fileWith(md)]);
    expect(count(payload, DESC)).toBe(1);
  });
});
