import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Icon } from "../components/Icon.js";

/**
 * `Icon` replaces ~380 hand-written inline SVGs (#810), so the thing worth pinning is that
 * the markup it emits is BYTE-EQUIVALENT to the boilerplate it retired — a primitive that
 * silently drops `stroke-width` or the round caps would change every icon in the client at
 * once, and no per-component test would notice. Each case below is the exact attribute set
 * the codemod matched on, asserted as attributes rather than as one HTML string so a React
 * attribute-order change is not a false failure.
 *
 * `renderToStaticMarkup` (no jsdom) is the client's convention for a pure component.
 */
function attrs(html: string): Record<string, string> {
  const open = /<svg\b([^>]*)>/.exec(html)![1];
  return Object.fromEntries([...open.matchAll(/([-\w:]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
}

describe("Icon (static render)", () => {
  it("emits the heroicons outline wrapper the codemod retired", () => {
    const html = renderToStaticMarkup(<Icon className="h-4 w-4" d="M4 8V4" />);
    expect(attrs(html)).toMatchObject({
      class: "h-4 w-4",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "2",
    });
    expect(html).toContain('<path stroke-linecap="round" stroke-linejoin="round" d="M4 8V4">');
    // `xmlns` was inert at every site that carried it and is deliberately not emitted.
    expect(html).not.toContain("xmlns");
  });

  it("emits no stroke at all for a solid icon", () => {
    const html = renderToStaticMarkup(<Icon solid className="w-3 h-3" d="M10 2a1 1 0" />);
    const a = attrs(html);
    expect(a.fill).toBe("currentColor");
    expect(a.stroke).toBeUndefined();
    expect(a["stroke-width"]).toBeUndefined();
    // A solid path carries no round caps — adding them would thicken every filled glyph.
    expect(html).toContain('<path d="M10 2a1 1 0">');
  });

  it("keeps a non-default strokeWidth and viewBox verbatim", () => {
    const html = renderToStaticMarkup(<Icon className="w-3 h-3" viewBox="0 0 20 20" strokeWidth={2.5} d="M5 5" />);
    expect(attrs(html)).toMatchObject({ viewBox: "0 0 20 20", "stroke-width": "2.5" });
  });

  it("passes children through untouched for multi-element art", () => {
    // The spinner shape: the wrapper collapses, the circle+path stay exactly as written.
    const html = renderToStaticMarkup(
      <Icon className="animate-spin h-4 w-4">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
      </Icon>,
    );
    expect(html).toContain('cx="12"');
    expect(html).toContain('d="M4 12a8 8 0 018-8v8z"');
    // No stray empty <path/> when `d` is absent — that would paint nothing but is still a
    // node other tests count.
    expect(html.match(/<path/g)).toHaveLength(1);
  });

  it("forwards arbitrary SVG props, so no site is forced back to a raw <svg>", () => {
    const html = renderToStaticMarkup(
      <Icon className="h-4 w-4" role="img" aria-label="close" style={{ opacity: 0.5 }} d="M6 18L18 6" />,
    );
    expect(attrs(html)).toMatchObject({ role: "img", "aria-label": "close" });
    expect(html).toContain("opacity:0.5");
  });
});
