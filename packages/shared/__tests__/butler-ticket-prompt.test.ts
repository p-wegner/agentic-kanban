import { describe, expect, it } from "vitest";
import { buildTicketChatPrompt } from "../src/lib/butler-ticket-prompt.js";

describe("buildTicketChatPrompt", () => {
  it("references the ticket by number when available", () => {
    const prompt = buildTicketChatPrompt({ issueNumber: 838, title: "Add a chat-about-ticket button" });
    expect(prompt).toContain("#838");
    expect(prompt).toContain("Add a chat-about-ticket button");
  });

  it("falls back to the title when there is no issue number", () => {
    const prompt = buildTicketChatPrompt({ issueNumber: null, title: "Some ticket" });
    expect(prompt).not.toContain("#");
    expect(prompt).toContain('"Some ticket"');
  });

  it("includes the retrospective questions from the ticket spec", () => {
    const prompt = buildTicketChatPrompt({ issueNumber: 1, title: "T" });
    expect(prompt).toContain("What took so long");
    expect(prompt).toContain("Where did the agents fail");
    expect(prompt).toContain("What context was missing");
    expect(prompt).toContain("improve the agent harness");
  });

  it("includes type and status metadata when provided", () => {
    const prompt = buildTicketChatPrompt({
      issueNumber: 5,
      title: "T",
      issueType: "feature",
      statusName: "Done",
    });
    expect(prompt).toContain("Type: feature");
    expect(prompt).toContain("Status: Done");
  });

  it("includes the description but truncates a very long one", () => {
    const longDesc = "x".repeat(2000);
    const prompt = buildTicketChatPrompt({ issueNumber: 5, title: "T", description: longDesc });
    expect(prompt).toContain("Ticket description:");
    expect(prompt).toContain("…");
    // Truncated well under the original length.
    expect(prompt.length).toBeLessThan(longDesc.length + 600);
  });

  it("omits the description section when empty or whitespace", () => {
    const prompt = buildTicketChatPrompt({ issueNumber: 5, title: "T", description: "   " });
    expect(prompt).not.toContain("Ticket description:");
  });
});
