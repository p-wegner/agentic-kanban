import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTicketContextMarkdown,
  buildStackProfileSection,
  writeTicketContextFile,
  TICKET_CONTEXT_FILENAME,
} from "@agentic-kanban/shared/lib/ticket-context";
import type { StackProfile } from "@agentic-kanban/shared";

function makeProfile(overrides: Partial<StackProfile> = {}): StackProfile {
  return {
    stack: "node",
    packageManager: "pnpm",
    isMonorepo: true,
    workspaces: ["packages/*"],
    installCommand: "pnpm install",
    buildCommand: "pnpm build",
    testCommand: "pnpm test",
    quickTestCommand: "pnpm test:mine",
    lintCommand: "pnpm lint",
    typecheckCommand: "pnpm typecheck",
    devCommand: "pnpm dev",
    isWeb: true,
    devHealthUrl: "http://localhost:5173",
    devPort: 5173,
    testDir: "src/__tests__",
    testRunner: "vitest",
    source: "detected",
    detectedMarkers: ["package.json", "pnpm-lock.yaml"],
    updatedAt: "2026-06-14T00:00:00.000Z",
    ...overrides,
  };
}

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

    it("injects the stack profile's exact feedback commands when provided", () => {
      const md = buildTicketContextMarkdown({
        title: "t",
        description: "d",
        stackProfile: makeProfile(),
      });
      expect(md).toContain("## Stack & Feedback Commands");
      expect(md).toContain("`pnpm test:mine`");
      expect(md).toContain("`pnpm build`");
      expect(md).toContain("`pnpm dev`");
      expect(md).toContain("**Stack:** node");
      expect(md).toContain("http://localhost:5173");
    });

    it("omits the stack section when no profile is provided", () => {
      const md = buildTicketContextMarkdown({ title: "t", description: "d" });
      expect(md).not.toContain("## Stack & Feedback Commands");
    });
  });

  describe("buildStackProfileSection", () => {
    it("returns null for a null/empty profile", () => {
      expect(buildStackProfileSection(null)).toBeNull();
      expect(buildStackProfileSection(undefined)).toBeNull();
      expect(
        buildStackProfileSection(
          makeProfile({
            quickTestCommand: null, testCommand: null, buildCommand: null,
            typecheckCommand: null, lintCommand: null, devCommand: null, installCommand: null,
          }),
        ),
      ).toBeNull();
    });

    it("renders only the commands that are present", () => {
      const section = buildStackProfileSection(
        makeProfile({
          buildCommand: null, lintCommand: null, typecheckCommand: null,
          devCommand: null, installCommand: null, isWeb: false, devHealthUrl: null,
        }),
      );
      expect(section).toContain("`pnpm test:mine`");
      expect(section).toContain("`pnpm test`");
      expect(section).not.toContain("Build:");
      expect(section).not.toContain("Dev server:");
      expect(section).not.toContain("Dev health URL");
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
