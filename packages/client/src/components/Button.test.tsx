import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "./Button.js";
import {
  buttonSizeClasses,
  buttonVariantClasses,
  iconButtonSizeClasses,
} from "../lib/buttonVariants.js";

describe("Button", () => {
  it("applies the variant's classes and defaults to primary", () => {
    const html = renderToStaticMarkup(<Button>Start</Button>);
    expect(html).toContain(buttonVariantClasses.primary);
    expect(html).toContain("Start");
  });

  it("resolves an explicit variant", () => {
    const html = renderToStaticMarkup(<Button variant="danger">Delete</Button>);
    expect(html).toContain(buttonVariantClasses.danger);
  });

  it("uses text padding by default and square padding when iconOnly", () => {
    const text = renderToStaticMarkup(<Button size="sm">Cancel</Button>);
    expect(text).toContain(buttonSizeClasses.sm);

    const iconOnly = renderToStaticMarkup(
      <Button variant="ghost" size="sm" iconOnly aria-label="close" icon={<svg data-testid="x" />} />,
    );
    expect(iconOnly).toContain(iconButtonSizeClasses.sm);
    expect(iconOnly).not.toContain(buttonSizeClasses.sm);
    expect(iconOnly).toContain("<svg");
  });

  it("defaults to type=button so it never submits a form by accident", () => {
    expect(renderToStaticMarkup(<Button>x</Button>)).toContain('type="button"');
    expect(renderToStaticMarkup(<Button type="submit">go</Button>)).toContain('type="submit"');
  });

  it("forwards native button props (disabled, onClick handler attrs, title)", () => {
    const html = renderToStaticMarkup(
      <Button disabled title="unavailable">
        x
      </Button>,
    );
    expect(html).toContain("disabled");
    expect(html).toContain('title="unavailable"');
  });

  it("appends the className escape hatch after the variant so callers can tweak layout", () => {
    const html = renderToStaticMarkup(<Button className="w-full">wide</Button>);
    expect(html).toContain("w-full");
    expect(html).toContain(buttonVariantClasses.primary);
  });
});
