import { test } from "node:test";
import assert from "node:assert/strict";
import { adfToMarkdown, markdownToAdf } from "../tools/lib/adf.mjs";

const doc = (...content) => ({ type: "doc", version: 1, content });
const p = (...content) => ({ type: "paragraph", content });
const t = (text, marks) => ({ type: "text", text, ...(marks ? { marks } : {}) });

test("heading + paragraph: blocks are separated by blank lines (KD-39 regression)", () => {
  const md = adfToMarkdown(
    doc({ type: "heading", attrs: { level: 2 }, content: [t("Steps")] }, p(t("Add two items")), p(t("Apply code SAVE10"))),
  );
  assert.equal(md, "## Steps\n\nAdd two items\n\nApply code SAVE10");
});

test("marks: inline code, strong, em, strike", () => {
  const md = adfToMarkdown(
    doc(p(t("a", [{ type: "code" }]), t(" "), t("b", [{ type: "strong" }]), t(" "), t("c", [{ type: "em" }]), t(" "), t("d", [{ type: "strike" }]))),
  );
  assert.equal(md, "`a` **b** _c_ ~~d~~");
});

test("link keeps its href", () => {
  const md = adfToMarkdown(doc(p(t("the spec", [{ type: "link", attrs: { href: "https://example.com/spec" } }]))));
  assert.equal(md, "[the spec](https://example.com/spec)");
});

test("codeBlock keeps its language", () => {
  const md = adfToMarkdown(
    doc({ type: "codeBlock", attrs: { language: "kotlin" }, content: [t("val total = items.sum() * 0.9")] }),
  );
  assert.equal(md, "```kotlin\nval total = items.sum() * 0.9\n```");
});

test("ordered and nested bullet lists", () => {
  const li = (...c) => ({ type: "listItem", content: c });
  const md = adfToMarkdown(
    doc(
      { type: "orderedList", content: [li(p(t("one"))), li(p(t("two")))] },
      {
        type: "bulletList",
        content: [li(p(t("outer")), { type: "bulletList", content: [li(p(t("inner")))] })],
      },
    ),
  );
  assert.equal(md, "1. one\n2. two\n\n- outer\n  - inner");
});

test("mention, hardBreak, blockquote, rule", () => {
  const md = adfToMarkdown(
    doc(
      p({ type: "mention", attrs: { id: "1", text: "@Ada" } }, t(" hi"), { type: "hardBreak" }, t("next")),
      { type: "blockquote", content: [p(t("quoted"))] },
      { type: "rule" },
    ),
  );
  assert.equal(md, "@Ada hi  \nnext\n\n> quoted\n\n---");
});

test("table renders as a Markdown table", () => {
  const cell = (text, type = "tableCell") => ({ type, content: [p(t(text))] });
  const md = adfToMarkdown(
    doc({
      type: "table",
      content: [
        { type: "tableRow", content: [cell("A", "tableHeader"), cell("B", "tableHeader")] },
        { type: "tableRow", content: [cell("1"), cell("2")] },
      ],
    }),
  );
  assert.equal(md, "| A | B |\n| --- | --- |\n| 1 | 2 |");
});

test("plain string passes through, null stays null, non-doc is null", () => {
  assert.equal(adfToMarkdown("plain"), "plain");
  assert.equal(adfToMarkdown(null), null);
  assert.equal(adfToMarkdown({ foo: 1 }), null);
});

test("markdownToAdf: marker line becomes emphasis, not literal underscores", () => {
  const adf = markdownToAdf("Looks good\n\n_Synced from agentic-kanban comment c7_");
  assert.equal(adf.content.length, 2);
  assert.deepEqual(adf.content[1].content, [t("Synced from agentic-kanban comment c7", [{ type: "em" }])]);
});

test("markdownToAdf: heading, list, code fence, link, inline marks", () => {
  const adf = markdownToAdf(
    "# Title\n\n- a\n  - b\n\n```ts\nconst x = 1;\n```\n\nSee [docs](https://x.io) for **bold** and `code`.",
  );
  assert.deepEqual(adf.content[0], { type: "heading", attrs: { level: 1 }, content: [t("Title")] });
  assert.equal(adf.content[1].type, "bulletList");
  assert.equal(adf.content[1].content[0].content[1].type, "bulletList");
  assert.deepEqual(adf.content[2], { type: "codeBlock", attrs: { language: "ts" }, content: [t("const x = 1;")] });
  const para = adf.content[3].content;
  assert.deepEqual(para[1], t("docs", [{ type: "link", attrs: { href: "https://x.io" } }]));
  assert.deepEqual(para[3], t("bold", [{ type: "strong" }]));
  assert.deepEqual(para[5], t("code", [{ type: "code" }]));
});

test("round trip: ADF -> Markdown -> ADF -> Markdown is stable", () => {
  const original = doc(
    { type: "heading", attrs: { level: 3 }, content: [t("H")] },
    p(t("x ", [{ type: "strong" }]), t("y")),
    { type: "codeBlock", attrs: { language: "sh" }, content: [t("ls -la")] },
  );
  const md = adfToMarkdown(original);
  assert.equal(adfToMarkdown(markdownToAdf(md)), md);
});
