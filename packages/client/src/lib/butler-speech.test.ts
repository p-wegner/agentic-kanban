import { describe, it, expect } from "vitest";
import { sanitizeSpeechText } from "./butler-speech.js";

describe("sanitizeSpeechText", () => {
  it("passes plain text through, trimmed", () => {
    expect(sanitizeSpeechText("  hello world  ")).toBe("hello world");
  });
  it("strips zero-width / BOM unicode codepoints", () => {
    // zero-width space, ZWNJ, ZWJ, word-joiner, LRM, RLM, BOM (explicit escapes)
    const dirty = "a​b‌‍⁠c‎‏﻿";
    expect(sanitizeSpeechText(dirty)).toBe("abc");
  });
  it("returns an empty string for zero-width-only + whitespace input", () => {
    expect(sanitizeSpeechText("​﻿   ")).toBe("");
  });
});
