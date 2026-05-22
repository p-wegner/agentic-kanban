import { describe, it, expect } from "vitest";
import { stripAnsi, extractMeaningfulOutput } from "@agentic-kanban/shared/lib/session-output.js";

describe("session-output", () => {
  describe("stripAnsi", () => {
    it("removes ANSI color codes", () => {
      expect(stripAnsi("\x1b[31mred text\x1b[0m")).toBe("red text");
    });

    it("removes ANSI escape sequences with multiple params", () => {
      expect(stripAnsi("\x1b[1;32;40mbold green\x1b[0m")).toBe("bold green");
    });

    it("normalizes CRLF to LF", () => {
      expect(stripAnsi("line1\r\nline2")).toBe("line1\nline2");
    });

    it("normalizes lone CR to LF", () => {
      expect(stripAnsi("line1\rline2")).toBe("line1\nline2");
    });

    it("returns plain strings unchanged", () => {
      expect(stripAnsi("hello world")).toBe("hello world");
    });

    it("handles empty string", () => {
      expect(stripAnsi("")).toBe("");
    });

    it("removes OSC sequences (title set)", () => {
      expect(stripAnsi("\x1b]0;title\x07rest")).toBe("rest");
    });
  });

  describe("extractMeaningfulOutput", () => {
    it("extracts text from assistant messages", () => {
      const messages = [
        {
          type: "stdout",
          data: JSON.stringify({
            type: "assistant",
            message: {
              content: [{ type: "text", text: "I will fix the bug now." }],
            },
          }),
        },
      ];
      const result = extractMeaningfulOutput(messages, 10);
      expect(result).toEqual(["I will fix the bug now."]);
    });

    it("extracts tool_use blocks", () => {
      const messages = [
        {
          type: "stdout",
          data: JSON.stringify({
            type: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  name: "Edit",
                  input: { file_path: "/src/foo.ts", old_string: "a", new_string: "b" },
                },
              ],
            },
          }),
        },
      ];
      const result = extractMeaningfulOutput(messages, 10);
      expect(result).toEqual(["[tool] Edit(file_path, old_string, new_string)"]);
    });

    it("extracts result messages", () => {
      const messages = [
        {
          type: "stdout",
          data: JSON.stringify({
            type: "result",
            result: "The fix has been applied successfully.",
          }),
        },
      ];
      const result = extractMeaningfulOutput(messages, 10);
      expect(result).toEqual(["The fix has been applied successfully."]);
    });

    it("skips result messages with subtype 'success'", () => {
      const messages = [
        {
          type: "stdout",
          data: JSON.stringify({
            type: "result",
            result: "success",
            subtype: "success",
          }),
        },
      ];
      const result = extractMeaningfulOutput(messages, 10);
      expect(result).toEqual([]);
    });

    it("extracts task_notification events", () => {
      const messages = [
        {
          type: "stdout",
          data: JSON.stringify({
            type: "system",
            subtype: "task_notification",
            summary: "Build completed",
          }),
        },
      ];
      const result = extractMeaningfulOutput(messages, 10);
      expect(result).toEqual(["[task] Build completed"]);
    });

    it("filters out api_retry noise", () => {
      const messages = [
        {
          type: "stdout",
          data: JSON.stringify({ subtype: "api_retry" }),
        },
      ];
      const result = extractMeaningfulOutput(messages, 10);
      expect(result).toEqual([]);
    });

    it("filters out system/init noise", () => {
      const messages = [
        {
          type: "stdout",
          data: JSON.stringify({ type: "system", subtype: "init", session_id: "abc" }),
        },
      ];
      const result = extractMeaningfulOutput(messages, 10);
      expect(result).toEqual([]);
    });

    it("passes through non-JSON lines with length > 2", () => {
      const messages = [
        { type: "stdout", data: "Some plain text output from the agent\n" },
      ];
      const result = extractMeaningfulOutput(messages, 10);
      expect(result).toEqual(["Some plain text output from the agent"]);
    });

    it("skips very short non-JSON lines", () => {
      const messages = [
        { type: "stdout", data: "ab\n" },
      ];
      const result = extractMeaningfulOutput(messages, 10);
      expect(result).toEqual([]);
    });

    it("skips stderr messages", () => {
      const messages = [
        { type: "stderr", data: "error output\n" },
      ];
      const result = extractMeaningfulOutput(messages, 10);
      expect(result).toEqual([]);
    });

    it("skips messages with null data", () => {
      const messages = [
        { type: "stdout", data: null },
      ];
      const result = extractMeaningfulOutput(messages, 10);
      expect(result).toEqual([]);
    });

    it("respects maxLines limit", () => {
      const messages = [];
      for (let i = 0; i < 20; i++) {
        messages.push({
          type: "stdout",
          data: JSON.stringify({
            type: "assistant",
            message: {
              content: [{ type: "text", text: `Line ${i}` }],
            },
          }),
        });
      }
      const result = extractMeaningfulOutput(messages, 5);
      expect(result.length).toBe(5);
    });

    it("handles mixed message types", () => {
      const messages = [
        { type: "stdout", data: JSON.stringify({ subtype: "api_retry" }) },
        {
          type: "stdout",
          data: JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "text", text: "Working on it" }] },
          }),
        },
        { type: "stderr", data: "warning message\n" },
        {
          type: "stdout",
          data: JSON.stringify({
            type: "result",
            result: "Done!",
          }),
        },
      ];
      const result = extractMeaningfulOutput(messages, 10);
      expect(result).toEqual(["Working on it", "Done!"]);
    });

    it("extracts rate_limit_event", () => {
      const messages = [
        {
          type: "stdout",
          data: JSON.stringify({
            type: "rate_limit_event",
            rate_limit_info: {
              status: "allowed",
              resetsAt: 1779492000,
              rateLimitType: "five_hour",
              overageStatus: "rejected",
              overageDisabledReason: "org_level_disabled",
              isUsingOverage: false,
            },
            uuid: "a64f60d7-08b9-4205-9a86-9fb0836be447",
            session_id: "594ffd37-ba74-490e-bad1-e03d3121a992",
          }),
        },
      ];
      const result = extractMeaningfulOutput(messages, 10);
      expect(result).toHaveLength(1);
      expect(result[0]).toContain("[rate_limit]");
      expect(result[0]).toContain("five_hour");
      expect(result[0]).toContain("allowed");
      expect(result[0]).toContain("overage rejected");
    });

    it("takes last line of multi-line text blocks", () => {
      const messages = [
        {
          type: "stdout",
          data: JSON.stringify({
            type: "assistant",
            message: {
              content: [{ type: "text", text: "line1\nline2\nline3" }],
            },
          }),
        },
      ];
      const result = extractMeaningfulOutput(messages, 10);
      expect(result).toEqual(["line3"]);
    });

    it("truncates long lines to 200 chars", () => {
      const longText = "a".repeat(300);
      const messages = [
        { type: "stdout", data: longText + "\n" },
      ];
      const result = extractMeaningfulOutput(messages, 10);
      expect(result[0].length).toBe(200);
    });
  });
});
