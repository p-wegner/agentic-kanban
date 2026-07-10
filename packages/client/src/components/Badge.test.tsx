import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Badge } from "./Badge.js";
import { badgeDotClasses, badgeToneClasses } from "../lib/badgeTones.js";

describe("Badge", () => {
  it("applies the tone's classes", () => {
    const html = renderToStaticMarkup(<Badge tone="danger">overdue</Badge>);
    expect(html).toContain(badgeToneClasses.danger);
    expect(html).toContain("overdue");
  });

  it("applies no tone classes when tone is omitted, so a caller-supplied palette wins", () => {
    const html = renderToStaticMarkup(<Badge className="bg-custom-100">bug</Badge>);
    expect(html).toContain("bg-custom-100");
    for (const classes of Object.values(badgeToneClasses)) {
      expect(html).not.toContain(classes);
    }
  });

  it("renders a pulsing dot matching the tone when dot is set", () => {
    const html = renderToStaticMarkup(
      <Badge tone="brand" dot>
        Creating issue
      </Badge>,
    );
    expect(html).toContain(badgeDotClasses.brand);
    expect(html).toContain("animate-pulse");
  });

  it("renders no dot by default", () => {
    const html = renderToStaticMarkup(<Badge tone="brand">x</Badge>);
    expect(html).not.toContain("animate-pulse");
  });

  it("renders the icon and exposes the title", () => {
    const html = renderToStaticMarkup(
      <Badge tone="warning" title="Needs visual verification" icon={<svg data-testid="eye" />}>
        verify
      </Badge>,
    );
    expect(html).toContain("<svg");
    expect(html).toContain('title="Needs visual verification"');
  });

  it("truncates long content inside the pill rather than letting it wrap", () => {
    const html = renderToStaticMarkup(<Badge tone="neutral">a-very-long-tag-name</Badge>);
    // `min-w-0` is what actually lets `truncate` engage on a flex child.
    expect(html).toContain("min-w-0 truncate");
    expect(html).toContain("max-w-full");
  });
});
