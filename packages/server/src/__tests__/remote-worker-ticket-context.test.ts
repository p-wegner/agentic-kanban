// #749 — a claude/copilot builder on a true-remote fleet worker had NO ticket context, and
// no remote agent has board MCP.
//
// The board writes `CLAUDE.local.md` into ITS worktree; a worker clones the repo into a
// checkout of its own, so the file was simply absent there. #524 fixed codex (the contents
// go into its prompt, its only channel) and left claude and copilot silently briefless.
//
// The second half is the honest one: the remote agent has no board MCP at all, so a context
// file telling it to call `create_issue` is an instruction it cannot follow. The file is
// therefore RETARGETED before it travels — the routing a dev-clone board renders for its own
// worktrees is not the routing a remote worktree needs.

import { describe, it, expect, vi } from "vitest";
import {
  BOARD_FEEDBACK_HEADING,
  TICKET_CONTEXT_FILENAME,
  buildBoardFeedbackSection,
  buildTicketContextMarkdown,
  retargetTicketContextForRemoteWorker,
} from "@agentic-kanban/shared/lib/ticket-context";
import { buildRemoteContextFiles } from "../services/remote-context-files.js";
import { parseBoardToWorkerMessage } from "@agentic-kanban/shared/lib/worker-protocol";

const BOARD_RENDERED = buildTicketContextMarkdown({
  issueNumber: 749,
  title: "fleet: a remote builder has no ticket context",
  description: "Ship the context file contents to the worker.",
  boardFeedback: {
    kind: "file-ticket",
    projectId: "d1c5d9c1-4897-4e1b-acc3-2aa96de04117",
    projectName: "agentic-kanban",
    isCurrentProject: false,
  },
});

describe("ticket context for a remote fleet worker (#749)", () => {
  it("the board-feedback section is rendered LAST, which is what makes retargeting safe", () => {
    // retargetTicketContextForRemoteWorker truncates from this heading, so a future
    // reordering that puts another section after it must fail HERE rather than silently
    // dropping that section from every remote worktree.
    const cut = BOARD_RENDERED.indexOf(BOARD_FEEDBACK_HEADING);
    expect(cut).toBeGreaterThan(-1);
    const tail = BOARD_RENDERED.slice(cut);
    const headings = tail.split("\n").filter((l) => l.startsWith("## "));
    expect(headings).toEqual([BOARD_FEEDBACK_HEADING]);
  });

  it("replaces the board's create_issue routing with something a worker can actually do", () => {
    const retargeted = retargetTicketContextForRemoteWorker(BOARD_RENDERED, {
      issuesUrl: "https://github.com/p-wegner/agentic-kanban/issues",
    });
    // The ticket itself is untouched — that is the whole point of shipping the file.
    expect(retargeted).toContain("# Ticket #749");
    expect(retargeted).toContain("Ship the context file contents to the worker.");

    // The unfulfillable instruction is gone.
    expect(BOARD_RENDERED).toContain("create_issue({ projectId:");
    expect(retargeted).not.toContain("create_issue({ projectId:");
    expect(retargeted).not.toContain("d1c5d9c1-4897-4e1b-acc3-2aa96de04117");

    // And what replaces it says why, and where a board bug goes instead.
    expect(retargeted).toContain("REMOTE FLEET WORKER");
    expect(retargeted).toContain("mcp__agentic-kanban__*");
    expect(retargeted).toContain("FINAL SUMMARY");
    expect(retargeted).toContain("https://github.com/p-wegner/agentic-kanban/issues");
  });

  it("appends the remote sections even when the board rendered no feedback routing", () => {
    const noRouting = buildTicketContextMarkdown({ issueNumber: 1, title: "t", description: "d" });
    expect(noRouting).not.toContain(BOARD_FEEDBACK_HEADING);
    const retargeted = retargetTicketContextForRemoteWorker(noRouting, { issuesUrl: "https://example.test/issues" });
    expect(retargeted).toContain("# Ticket #1");
    expect(retargeted).toContain("REMOTE FLEET WORKER");
    expect(retargeted).toContain("https://example.test/issues");
  });

  it("the remote-worker routing names the machine boundary, not a board deployment", () => {
    const section = buildBoardFeedbackSection({
      kind: "gh-issue",
      issuesUrl: "https://example.test/issues",
      deployment: "remote-worker",
    });
    expect(section).toContain("REMOTE FLEET WORKER");
    expect(section).toContain("no board MCP server");
    // Not conflated with a packaged/containerized BOARD, which is a different situation.
    expect(section).not.toContain("installed package");
    expect(section).not.toContain("container image");
  });
});

describe("buildRemoteContextFiles (#749)", () => {
  it("ships name + content, retargeting the ticket-context file", () => {
    const files = buildRemoteContextFiles(
      [`C:\\board\\.worktrees\\feature-749\\${TICKET_CONTEXT_FILENAME}`],
      { issuesUrl: "https://example.test/issues", readFile: () => BOARD_RENDERED },
    );
    expect(files).toHaveLength(1);
    // A BASENAME, never a board path — the worker writes it into its own checkout root.
    expect(files[0].name).toBe(TICKET_CONTEXT_FILENAME);
    expect(files[0].name).not.toContain("\\");
    expect(files[0].content).toContain("REMOTE FLEET WORKER");
    expect(files[0].content).not.toContain("create_issue({ projectId:");
  });

  it("leaves any other context file's content alone", () => {
    const files = buildRemoteContextFiles(["/board/wt/NOTES.md"], { readFile: () => "raw notes" });
    expect(files).toEqual([{ name: "NOTES.md", content: "raw notes" }]);
  });

  it("a missing context file degrades the brief, it does not fail the launch", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const files = buildRemoteContextFiles(["/gone.md"], {
        readFile: () => { throw new Error("ENOENT"); },
      });
      expect(files).toEqual([]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("no context files means no payload at all", () => {
    expect(buildRemoteContextFiles(undefined)).toEqual([]);
    expect(buildRemoteContextFiles([])).toEqual([]);
  });

  it("survives the wire, and the parser refuses a name that would escape the checkout", () => {
    const files = buildRemoteContextFiles([`/board/wt/${TICKET_CONTEXT_FILENAME}`], {
      readFile: () => BOARD_RENDERED,
    });
    const parsed = parseBoardToWorkerMessage(JSON.stringify({
      type: "assign",
      sessionId: "s1",
      spec: { command: "claude", args: [], cwd: "/x" },
      repo: {
        projectId: "p1", gitPort: 1234, gitToken: "t", branch: "b", baseBranch: "main",
        incomingRef: "refs/kanban/incoming/b",
        contextFiles: [
          ...files,
          { name: "../../escape.md", content: "nope" },
          { name: "C:\\escape.md", content: "nope" },
        ],
      },
    }));
    if (parsed?.type !== "assign") throw new Error("unreachable");
    expect(parsed.repo?.contextFiles?.map((f) => f.name)).toEqual([TICKET_CONTEXT_FILENAME]);
  });
});
