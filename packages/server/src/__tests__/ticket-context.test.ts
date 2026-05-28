import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTicketContextMarkdown,
  writeTicketContextFile,
  TICKET_CONTEXT_FILENAME,
} from "@agentic-kanban/shared/lib/ticket-context";

describe("ticket-context", () => {
  describe("buildTicketContextMarkdown", () => {
    it("includes the issue number, title, and description", () => {
      const md = buildTicketContextMarkdown({
        issueNumber: 88,
        title: "Inject ticket context into worktree",
        description: "Make the ticket details available in the first prompt.",
      });
      expect(md).toContain("# Ticket #88: Inject ticket context into worktree");
      expect(md).toContain("Make the ticket details available in the first prompt.");
      // Sentinel marker present so the file is identifiable/strippable
      expect(md).toContain("ak-ticket-context");
    });

    it("falls back to a plain heading when there is no issue number", () => {
      const md = buildTicketContextMarkdown({ issueNumber: null, title: "No number", description: "x" });
      expect(md).toContain("# Ticket: No number");
      expect(md).not.toContain("Ticket #");
    });

    it("renders a placeholder when description is missing or blank", () => {
      expect(buildTicketContextMarkdown({ title: "t", description: null })).toContain("_(No description provided.)_");
      expect(buildTicketContextMarkdown({ title: "t", description: "   " })).toContain("_(No description provided.)_");
    });
  });

  describe("writeTicketContextFile", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "ak-ticket-ctx-"));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("writes CLAUDE.local.md into the worktree root with the ticket content", async () => {
      const written = await writeTicketContextFile(dir, {
        issueNumber: 42,
        title: "Some task",
        description: "Some description",
      });

      expect(written).toBe(join(dir, TICKET_CONTEXT_FILENAME));
      const content = (await readFile(join(dir, TICKET_CONTEXT_FILENAME), "utf-8")).trim();
      expect(content).toContain("# Ticket #42: Some task");
      expect(content).toContain("Some description");
    });

    it("returns null instead of throwing when the target directory does not exist", async () => {
      const written = await writeTicketContextFile(join(dir, "does", "not", "exist"), {
        title: "t",
        description: "d",
      });
      expect(written).toBeNull();
    });
  });
});
