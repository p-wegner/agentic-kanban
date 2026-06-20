import { describe, expect, it } from "vitest";
import { getLanguage, tokenizeJS, tokenizeJSON, tokenizeCSS, tokenizeMD } from "./diff-highlight.js";

const join = (toks: { v: string }[]) => toks.map((t) => t.v).join("");

describe("getLanguage", () => {
  it("maps file extensions to a highlighter language", () => {
    expect(getLanguage("src/x.ts")).toBe("js");
    expect(getLanguage("a.tsx")).toBe("js");
    expect(getLanguage("a.mjs")).toBe("js");
    expect(getLanguage("data.json")).toBe("json");
    expect(getLanguage("styles.scss")).toBe("css");
    expect(getLanguage("README.md")).toBe("md");
    expect(getLanguage("Makefile")).toBe("plain");
  });
});

describe("tokenizers are lossless", () => {
  const cases: Array<[string, (s: string) => { v: string }[]]> = [
    ["const x = 'hi'; // c", tokenizeJS],
    ['{ "a": 1, "b": [true, null] }', tokenizeJSON],
    [".cls { color: #fff; margin: 0 }", tokenizeCSS],
    ["# Title\n- **bold** item", tokenizeMD],
  ];
  it.each(cases)("re-joins to the original input: %s", (input, fn) => {
    expect(join(fn(input))).toBe(input);
  });
});

describe("tokenizeJS classification", () => {
  it("classifies keywords, strings, and comments", () => {
    const toks = tokenizeJS("const s = \"x\"; // note");
    expect(toks.some((t) => t.t === "kw" && t.v === "const")).toBe(true);
    expect(toks.some((t) => t.t === "str")).toBe(true);
    expect(toks.some((t) => t.t === "cmt")).toBe(true);
  });
});
