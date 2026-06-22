import React from "react";

// Syntax highlighting — minimal tokenizer for ts/tsx/js/jsx/json/css/md
// Uses the editorial palette from chartColors.ts (no hard-coded raw blue/green).

const HIGHLIGHT_MAX_LINE_LEN = 500; // skip highlighting for very long lines

export type Token = { t: "kw" | "str" | "num" | "cmt" | "fn" | "op" | "tag" | "attr" | "plain"; v: string };

// Color map: token kind -> inline style color.
// Values sourced from the editorial palette in chartColors.ts.
const TOKEN_COLORS: Record<Token["t"], string | undefined> = {
  kw:    "#7c5cbf",  // soft purple for keywords (distinct, brand-adjacent)
  str:   "#547446",  // accent sage (matches ACCENT / Done)
  num:   "#c79a3e",  // warm ochre (matches chore/medium priority)
  cmt:   "#a8a195",  // ink-faint warm gray (matches Backlog)
  fn:    "#5b7a8c",  // muted slate-teal (matches task type)
  op:    "#c25f36",  // brand terracotta for operators/punctuation
  tag:   "#d17d54",  // brand-400 lighter (matches In Review)
  attr:  "#7c5cbf",  // same as kw
  plain: undefined,
};

export function tokenColor(t: Token["t"]): React.CSSProperties {
  const c = TOKEN_COLORS[t];
  return c ? { color: c } : {};
}

// --- Language-specific tokenizers ---

const JS_KEYWORDS = new Set([
  "break","case","catch","class","const","continue","debugger","default","delete",
  "do","else","export","extends","finally","for","from","function","if","import",
  "in","instanceof","let","new","of","return","static","super","switch","this",
  "throw","try","typeof","var","void","while","with","yield",
  "async","await","interface","type","enum","namespace","declare","abstract",
  "implements","override","as","satisfies","keyof","infer","never","unknown",
  "true","false","null","undefined",
]);

export function tokenizeJS(code: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < code.length) {
    // Single-line comment
    if (code[i] === "/" && code[i + 1] === "/") {
      tokens.push({ t: "cmt", v: code.slice(i) });
      break;
    }
    // Multi-line comment (single line display)
    if (code[i] === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      const s = end === -1 ? code.slice(i) : code.slice(i, end + 2);
      tokens.push({ t: "cmt", v: s });
      i += s.length;
      continue;
    }
    // Template literal
    if (code[i] === "`") {
      let j = i + 1;
      while (j < code.length && code[j] !== "`") {
        if (code[j] === "\\") j++;
        j++;
      }
      tokens.push({ t: "str", v: code.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    // String
    if (code[i] === '"' || code[i] === "'") {
      const q = code[i];
      let j = i + 1;
      while (j < code.length && code[j] !== q) {
        if (code[j] === "\\") j++;
        j++;
      }
      tokens.push({ t: "str", v: code.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    // Number
    if (/[0-9]/.test(code[i]) || (code[i] === "." && /[0-9]/.test(code[i + 1] ?? ""))) {
      let j = i;
      while (j < code.length && /[0-9a-fA-F_.xXoObBnN]/.test(code[j])) j++;
      tokens.push({ t: "num", v: code.slice(i, j) });
      i = j;
      continue;
    }
    // Identifier / keyword
    if (/[a-zA-Z_$]/.test(code[i])) {
      let j = i;
      while (j < code.length && /[a-zA-Z0-9_$]/.test(code[j])) j++;
      const word = code.slice(i, j);
      const isKw = JS_KEYWORDS.has(word);
      // Function call: word followed by optional whitespace then (
      const afterWord = code.slice(j).trimStart();
      const isFn = !isKw && afterWord.startsWith("(");
      tokens.push({ t: isKw ? "kw" : isFn ? "fn" : "plain", v: word });
      i = j;
      continue;
    }
    // Operator / punctuation
    const op = code[i];
    if (/[=+\-*/%<>!&|^~?:;,.()[\]{}]/.test(op)) {
      tokens.push({ t: "op", v: op });
      i++;
      continue;
    }
    // Whitespace / other
    let j = i;
    while (j < code.length && !/[a-zA-Z0-9_$`"'=+\-*/%<>!&|^~?:;,.()[\]{}/]/.test(code[j])) j++;
    if (j === i) j = i + 1;
    tokens.push({ t: "plain", v: code.slice(i, j) });
    i = j;
  }
  return tokens;
}

export function tokenizeJSON(code: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < code.length) {
    if (code[i] === '"') {
      let j = i + 1;
      while (j < code.length && code[j] !== '"') {
        if (code[j] === "\\") j++;
        j++;
      }
      // If followed by ':', it's a key → use attr color
      const after = code.slice(j + 1).trimStart();
      tokens.push({ t: after.startsWith(":") ? "attr" : "str", v: code.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(code[i])) {
      let j = i + (code[i] === "-" ? 1 : 0);
      while (j < code.length && /[0-9.eE+-]/.test(code[j])) j++;
      if (j > i) { tokens.push({ t: "num", v: code.slice(i, j) }); i = j; continue; }
    }
    if (code.slice(i, i + 4) === "true" || code.slice(i, i + 5) === "false" || code.slice(i, i + 4) === "null") {
      const w = code[i + 0] === "t" ? "true" : code[i] === "f" ? "false" : "null";
      tokens.push({ t: "kw", v: w });
      i += w.length;
      continue;
    }
    tokens.push({ t: "op", v: code[i] });
    i++;
  }
  return tokens;
}

export function tokenizeCSS(code: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < code.length) {
    if (code[i] === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      const s = end === -1 ? code.slice(i) : code.slice(i, end + 2);
      tokens.push({ t: "cmt", v: s }); i += s.length; continue;
    }
    if (code[i] === '"' || code[i] === "'") {
      const q = code[i]; let j = i + 1;
      while (j < code.length && code[j] !== q) { if (code[j] === "\\") j++; j++; }
      tokens.push({ t: "str", v: code.slice(i, j + 1) }); i = j + 1; continue;
    }
    if (/[0-9]/.test(code[i])) {
      let j = i;
      while (j < code.length && /[0-9.%a-zA-Z]/.test(code[j])) j++;
      tokens.push({ t: "num", v: code.slice(i, j) }); i = j; continue;
    }
    // CSS property / selector
    if (/[a-zA-Z_-]/.test(code[i])) {
      let j = i;
      while (j < code.length && /[a-zA-Z0-9_-]/.test(code[j])) j++;
      const word = code.slice(i, j);
      const after = code.slice(j).trimStart();
      tokens.push({ t: after.startsWith(":") ? "kw" : "plain", v: word });
      i = j; continue;
    }
    if (code[i] === "#") {
      let j = i + 1;
      while (j < code.length && /[a-fA-F0-9]/.test(code[j])) j++;
      tokens.push({ t: "num", v: code.slice(i, j) }); i = j; continue;
    }
    tokens.push({ t: "op", v: code[i] }); i++;
  }
  return tokens;
}

export function tokenizeMD(code: string): Token[] {
  // Headings
  if (/^#{1,6}\s/.test(code)) return [{ t: "kw", v: code }];
  // Code span
  const tokens: Token[] = [];
  let i = 0;
  while (i < code.length) {
    if (code[i] === "`") {
      let j = i + 1;
      while (j < code.length && code[j] !== "`") j++;
      tokens.push({ t: "str", v: code.slice(i, j + 1) });
      i = j + 1; continue;
    }
    if (code[i] === "*" || code[i] === "_") {
      tokens.push({ t: "op", v: code[i] }); i++; continue;
    }
    let j = i;
    while (j < code.length && code[j] !== "`" && code[j] !== "*" && code[j] !== "_") j++;
    if (j === i) j = i + 1;
    tokens.push({ t: "plain", v: code.slice(i, j) }); i = j;
  }
  return tokens;
}

export function getLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "ts" || ext === "tsx" || ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs") return "js";
  if (ext === "json") return "json";
  if (ext === "css" || ext === "scss" || ext === "less") return "css";
  if (ext === "md" || ext === "mdx") return "md";
  return "plain";
}

export function highlightLine(code: string, lang: string): React.ReactNode {
  if (lang === "plain" || code.length > HIGHLIGHT_MAX_LINE_LEN) return code;
  let tokens: Token[];
  if (lang === "js") tokens = tokenizeJS(code);
  else if (lang === "json") tokens = tokenizeJSON(code);
  else if (lang === "css") tokens = tokenizeCSS(code);
  else if (lang === "md") tokens = tokenizeMD(code);
  else return code;

  return tokens.map((tok, idx) =>
    TOKEN_COLORS[tok.t]
      ? <span key={idx} style={tokenColor(tok.t)}>{tok.v}</span>
      : tok.v
  );
}
