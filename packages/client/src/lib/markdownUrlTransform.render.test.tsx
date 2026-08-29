import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { markdownUrlTransform } from "./markdownUrlTransform.js";
import { mergeDescriptionWithImages } from "./pastedImages.js";

/**
 * End-to-end proof of the #941 fix.
 *
 * The unit tests next door assert the transform in isolation; these render the
 * real `<ReactMarkdown>` pipeline, because the bug was never in our own code —
 * it was react-markdown's `defaultUrlTransform` rewriting the data URI to `""`
 * AFTER we handed it a correct one. Only a rendered `<img src>` shows that.
 */
describe("rendering an issue description that embeds a pasted screenshot", () => {
  // A real 1x1 transparent PNG, the shape a clipboard paste produces.
  const PNG =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

  const render = (markdown: string) =>
    renderToStaticMarkup(
      <ReactMarkdown urlTransform={markdownUrlTransform}>{markdown}</ReactMarkdown>,
    );

  /**
   * A blocked URL becomes `""`, and React drops an empty `src`/`href` from
   * static markup entirely — so "blocked" reads as the attribute being absent,
   * not present-and-empty.
   */
  const expectNoImageSource = (html: string) => {
    expect(html).toContain("<img");
    expect(html).not.toMatch(/<img[^>]*\ssrc=/);
  };

  it("renders the screenshot with its data URI intact", () => {
    const html = render(mergeDescriptionWithImages("Steps to reproduce", [PNG]));
    expect(html).toContain(`src="${PNG}"`);
    expect(html).toContain("Steps to reproduce");
  });

  it("is a real regression guard: the default transform blanks the src", () => {
    // Without the fix — bare <ReactMarkdown>, as every issue-text surface used to
    // be — the same markdown renders an empty src. That is exactly what the
    // ticket screenshot showed, and what must never come back.
    const html = renderToStaticMarkup(
      <ReactMarkdown>{mergeDescriptionWithImages("", [PNG])}</ReactMarkdown>,
    );
    expectNoImageSource(html);
    expect(html).not.toContain("base64");
  });

  it("does not render a scriptable data URI even through the fixed pipeline", () => {
    const html = render("![x](data:text/html,<script>alert(1)</script>)");
    expect(html).not.toContain("alert(1)");
    expectNoImageSource(html);
  });

  it("does not render an SVG data URI, which can carry script", () => {
    const html = render("![x](data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Lz48L3N2Zz4=)");
    expectNoImageSource(html);
    expect(html).not.toContain("svg");
  });

  it("still blocks javascript: links", () => {
    const html = render("[click](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
  });

  it("leaves ordinary image and link URLs alone", () => {
    const html = render("![a](https://example.com/a.png) and [b](https://example.com)");
    expect(html).toContain('src="https://example.com/a.png"');
    expect(html).toContain('href="https://example.com"');
  });
});
