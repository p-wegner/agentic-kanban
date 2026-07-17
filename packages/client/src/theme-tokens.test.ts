import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The editorial theme (app.css) promises that "the whole palette can be
 * re-tuned from this one place". That promise only holds while the global
 * stylesheets reference tokens instead of re-typing their values.
 *
 * It had already broken: `.markdown-body` re-hardcoded eight token hexes 200
 * lines below where @theme defined them, and its dark rules had drifted onto
 * cold Tailwind grays (#d1d5db/#f3f4f6) that no palette edit could reach.
 * These gates cover the two global stylesheets only — per-component Tailwind
 * utilities are a separate, much larger migration.
 */

const CLIENT_SRC = join(__dirname);
const GLOBAL_STYLESHEETS = ["app.css", join("components", "BoardColumn.css")];

const readCss = (rel: string) => readFileSync(join(CLIENT_SRC, rel), "utf8");

/** The `@theme { ... }` block — the one sanctioned home for raw colour values. */
function extractThemeBlock(css: string): string {
  const start = css.indexOf("@theme {");
  expect(start, "app.css must declare an @theme block").toBeGreaterThan(-1);
  const end = css.indexOf("\n}", start);
  return css.slice(start, end);
}

function parseTokens(themeBlock: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const [, name, value] of themeBlock.matchAll(
    /(--color-[\w-]+):\s*(#[0-9a-fA-F]{3,8});/g,
  )) {
    tokens.set(name, value.toLowerCase());
  }
  return tokens;
}

/** Strip comments so documented example values aren't mistaken for real rules. */
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("editorial theme tokens", () => {
  const appCss = readCss("app.css");
  const tokens = parseTokens(extractThemeBlock(appCss));

  it("defines the palette it claims to", () => {
    expect(tokens.size).toBeGreaterThan(20);
    // A dark counterpart must exist for every ink token: the theme swaps
    // tokens rather than re-declaring values under `.dark`, so a missing
    // -dark token is what pushes authors back onto cold grays.
    for (const ink of ["--color-ink", "--color-ink-soft", "--color-ink-faint"]) {
      expect(tokens.has(ink), `${ink} missing`).toBe(true);
      expect(tokens.has(`${ink}-dark`), `${ink}-dark missing`).toBe(true);
    }
  });

  it.each(GLOBAL_STYLESHEETS)("%s re-uses tokens instead of re-typing their hexes", (file) => {
    const css = stripComments(readCss(file));
    const body = file === "app.css" ? css.replace(extractThemeBlock(css), "") : css;

    const byValue = new Map<string, string>();
    for (const [name, value] of tokens) if (!byValue.has(value)) byValue.set(value, name);

    const duplicated = [...body.matchAll(/#[0-9a-fA-F]{3,8}\b/g)]
      .map((m) => m[0].toLowerCase())
      .filter((hex) => byValue.has(hex))
      .map((hex) => `${hex} -> use var(${byValue.get(hex)})`);

    expect([...new Set(duplicated)]).toEqual([]);
  });

  it.each(GLOBAL_STYLESHEETS)("%s tints with ink, not raw black/white", (file) => {
    const css = stripComments(readCss(file));
    // `rgba(0,0,0,.12)` / `rgb(255 255 255 / 0.1)` on a warm paper surface read
    // as a cold artefact. Alpha tints belong on an ink token via color-mix().
    const rawNeutrals = [...css.matchAll(/rgba?\(\s*(0\s*,\s*0\s*,\s*0|255\s*,\s*255\s*,\s*255|0\s+0\s+0|255\s+255\s+255)\b[^)]*\)/g)].map(
      (m) => m[0],
    );
    expect(rawNeutrals).toEqual([]);
  });
});
