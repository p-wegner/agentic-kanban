import { describe, it, expect } from "vitest";
import { extractJsonObject } from "../services/issue-ai.service.js";

describe("extractJsonObject (touched-files prediction robustness)", () => {
  it("parses a bare JSON object", () => {
    const out = '{"files": [{"path": "a.ts", "reason": "x", "confidence": "high"}]}';
    expect(extractJsonObject(out)).toEqual({
      files: [{ path: "a.ts", reason: "x", confidence: "high" }],
    });
  });

  it("parses JSON wrapped in a ```json fence", () => {
    const out = '```json\n{"files": []}\n```';
    expect(extractJsonObject(out)).toEqual({ files: [] });
  });

  it("parses JSON wrapped in a bare ``` fence", () => {
    const out = '```\n{"files": []}\n```';
    expect(extractJsonObject(out)).toEqual({ files: [] });
  });

  // This is the exact failure mode from ticket #132: Haiku prefixes the JSON
  // with conversational prose, so the old fence-only cleanup left the prose in
  // place and JSON.parse threw — the prediction "always failed on a ticket".
  it("parses JSON preceded by conversational prose", () => {
    const out =
      'Perfect! Here are the files that will likely be modified:\n\n' +
      '```json\n{"files": [{"path": "x.ts", "reason": "y", "confidence": "medium"}]}\n```';
    expect(extractJsonObject(out)).toEqual({
      files: [{ path: "x.ts", reason: "y", confidence: "medium" }],
    });
  });

  it("parses JSON with leading prose and no fence", () => {
    const out = 'Sure, here is the result: {"files": []} Let me know if you need more.';
    expect(extractJsonObject(out)).toEqual({ files: [] });
  });

  it("parses JSON with trailing prose", () => {
    const out = '{"files": []}\n\nThat should cover the main changes needed.';
    expect(extractJsonObject(out)).toEqual({ files: [] });
  });

  it("throws on empty input", () => {
    expect(() => extractJsonObject("")).toThrow(/empty model response/);
  });

  it("throws when no JSON object is present", () => {
    expect(() => extractJsonObject("I could not determine the files.")).toThrow(
      /no JSON object found/,
    );
  });
});
