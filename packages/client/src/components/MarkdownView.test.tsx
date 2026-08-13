import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownView } from "./MarkdownView.js";

/**
 * These assert GFM is ON. The regression they guard is not hypothetical: the artifact
 * viewer shipped with bare `<ReactMarkdown>` and rendered a 50-row acceptance-criteria
 * table as 16 paragraphs of literal `|` pipes, while its `prose-table:*` classes made
 * it look like tables were handled.
 */
describe("MarkdownView", () => {
  const TABLE = `| Story | Result |\n| --- | --- |\n| STORY-2-1 | auto |`;

  it("renders a GFM table as a real table, not pipe-text", () => {
    const html = renderToStaticMarkup(<MarkdownView>{TABLE}</MarkdownView>);
    expect(html).toContain("<table");
    expect(html).toContain("STORY-2-1");
    // The row text must not survive as a literal pipe line anywhere.
    expect(html).not.toContain("| STORY-2-1 |");
  });

  it("keeps the table in table layout and puts the overflow on a wrapper", () => {
    const html = renderToStaticMarkup(<MarkdownView>{TABLE}</MarkdownView>);
    expect(html).toMatch(/overflow-x-auto[^>]*>\s*<table/);
    // `display:block` on the table itself un-aligns every column — it must not come back.
    expect(html).not.toMatch(/<table[^>]*class="[^"]*\bblock\b/);
  });

  it("renders a task list without a focusable checkbox (the file is read-only here)", () => {
    const html = renderToStaticMarkup(<MarkdownView>{"- [x] done\n- [ ] open"}</MarkdownView>);
    expect(html).not.toContain("<input");
    expect(html).toContain("☑");
    expect(html).toContain("☐");
  });

  it("supports the rest of GFM: strikethrough and autolinks", () => {
    const html = renderToStaticMarkup(<MarkdownView>{"~~gone~~ and https://example.com"}</MarkdownView>);
    expect(html).toContain("<del>");
    expect(html).toContain('href="https://example.com"');
  });

  it("lets a caller override one element without losing the table defaults", () => {
    const html = renderToStaticMarkup(
      <MarkdownView components={{ h1: ({ children }) => <h1 data-custom="1">{children}</h1> }}>
        {`# Title\n\n${TABLE}`}
      </MarkdownView>,
    );
    expect(html).toContain('data-custom="1"');
    expect(html).toContain("<table");
  });
});
