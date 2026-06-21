import { describe, it, expect } from "vitest";
import { sanitizeSpeechText } from "./butler-speech.js";

// Build inputs from codepoints so the (invisible) zero-width / control chars are
// unambiguous in source — typing them literally is unreliable.
const ZERO_WIDTH = [0x200b, 0x200c, 0x200d, 0x2060, 0x180e, 0x200e, 0x200f, 0xfeff];
const cc = (...codes: number[]) => codes.map((c) => String.fromCharCode(c)).join("");

describe("sanitizeSpeechText", () => {
  it("passes plain text through, trimmed", () => {
    expect(sanitizeSpeechText("  hello world  ")).toBe("hello world");
  });
  it("strips all 8 zero-width / format / BOM codepoints (incl. U+180E)", () => {
    const dirty = "a" + cc(ZERO_WIDTH[0]) + "b" + cc(...ZERO_WIDTH.slice(1)) + "c";
    expect(sanitizeSpeechText(dirty)).toBe("abc");
  });
  it("strips control characters (C0 / DEL / C1 ranges)", () => {
    // 0x07 (C0), 0x1f (C0 end), 0x7f (DEL), 0x9f (C1 end)
    expect(sanitizeSpeechText("a" + cc(0x07, 0x1f) + "b" + cc(0x7f, 0x9f) + "c")).toBe("abc");
  });
  it("returns an empty string for zero-width-only + whitespace input", () => {
    expect(sanitizeSpeechText(cc(0x200b, 0xfeff) + "   ")).toBe("");
  });
});
