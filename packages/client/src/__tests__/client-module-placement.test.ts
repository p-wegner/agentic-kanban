// @gate:always-run — scans the client source tree by path; imports nothing it checks.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Pure modules live in `lib/` (#589).
 *
 * The client already had this pattern and no name for it: a pure view-model in `lib/`
 * beside the component or hook that renders it. The evidence it was real is the test
 * ratio — 85 test files for 125 `lib/` files, against 43 for 244 components — and the
 * evidence it was unenforced is that five pure modules had drifted into `components/`
 * and `hooks/`, where nothing tests them by convention and a reader does not look.
 *
 * `components/` is `.tsx`; `hooks/` is `use*`. Anything else is a stray.
 */
const clientSrc = path.join(import.meta.dirname!, "..");

/**
 * Lazy-import WIRING for components, not logic: it names the component modules and exists
 * to code-split them. The one file that is correctly a `.ts` inside `components/`.
 */
const COMPONENT_TS_ALLOWED = new Set(["boardLazyViews.ts"]);

function filesIn(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);
}

describe("client module placement (#589)", () => {
  it("components/ holds no pure .ts module", () => {
    const strays = filesIn(path.join(clientSrc, "components"))
      .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && !n.endsWith(".d.ts"))
      .filter((n) => !COMPONENT_TS_ALLOWED.has(n));
    expect(
      strays,
      "a pure module belongs in lib/ (see packages/client/CLAUDE.md):\n" + strays.join("\n"),
    ).toEqual([]);
  });

  it("hooks/ holds only use* modules", () => {
    const strays = filesIn(path.join(clientSrc, "hooks"))
      .filter((n) => (n.endsWith(".ts") || n.endsWith(".tsx")) && !n.includes(".test."))
      .filter((n) => !n.startsWith("use") && !n.startsWith("create"));
    expect(
      strays,
      "a hooks/ module is a `use*` hook (or a `create*` action-bundle factory); pure logic " +
        "goes to lib/:\n" + strays.join("\n"),
    ).toEqual([]);
  });

  it("the scan reaches both directories", () => {
    // A path typo would make both assertions vacuously green.
    expect(filesIn(path.join(clientSrc, "components")).length).toBeGreaterThan(50);
    expect(filesIn(path.join(clientSrc, "hooks")).length).toBeGreaterThan(20);
  });
});
