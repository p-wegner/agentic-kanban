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

  /**
   * `lib/` IS the client's domain layer — there is no second one (#742).
   *
   * #742 read `code-metrics --layer-fit` reporting the client's centre of gravity as
   * **0.000 over 12,730 decision points** and concluded the client "has no domain layer at
   * all", prescribing a new `client/src/domain/`. Both halves were re-derived against the
   * tool's own source and neither holds:
   *
   * - **0.000 is not measurable off zero.** Layer roles are inferred from path convention,
   *   and the `frontend` rule matches `(?:^|/)client/` before any `domain`/`model` rule is
   *   tried. Calling the tool's `infer_role` on `packages/client/src/domain/foo.ts` returns
   *   `frontend`. Every file in this package is role `frontend` = axis position 0, so the
   *   client's centre of gravity is pinned at exactly 0.000 by the package's NAME. Creating
   *   the directory it asked for would not move the number it was asked to move.
   * - **The 39 `model_in_view` + 8 `query_in_adapter` "extraction sites" were tool false
   *   positives**, fixed upstream in code-metrics `b3a4836` ("the layer rules fired on
   *   Promise.all") hours after #742 was filed. Re-running the current runner over this tree:
   *   0 `model_in_view`, 1 `query_in_adapter` — and that one is `ref.current?.select()`.
   *   The named per-file counts reproduce exactly as `X_COMMANDS.includes(base)` array
   *   membership tests and `tab.group !== lastGroup` property reads.
   *
   * What IS true is the placement rule this file already guards, so the decision is: no third
   * category. A pure module goes to `lib/`, which by decision-point mass carries 20% of the
   * client's logic against 98 co-located test files (`components/`: 69%, 42 tests). Splitting
   * that into `lib/` + `domain/` would leave the next author guessing which, and the metric
   * that motivated it cannot tell them apart.
   *
   * The part of #742 that DOES survive — 69% of the client's decision points sit in
   * `components/` at a 1:5.8 test-file ratio against 1:1.5 in `lib/` — is disclosed with its
   * measurement in **#796**, along with the cheaper real fix (`[roles]` overrides in
   * `.codemetricsrc` so layer-fit stops reporting a naming artifact as a structural absence).
   */
  const PURE_LOGIC_DIR_ALIASES = ["domain", "domains", "model", "models", "entities", "services", "core"];

  it("client/src grows no second home for pure logic", () => {
    const strays = fs.readdirSync(clientSrc, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((n) => PURE_LOGIC_DIR_ALIASES.includes(n.toLowerCase()));
    expect(
      strays,
      "lib/ is the client's domain layer (#742 — see the docblock above): " + strays.join(", "),
    ).toEqual([]);
  });

  it("the scan reaches both directories", () => {
    // A path typo would make both assertions vacuously green.
    expect(filesIn(path.join(clientSrc, "components")).length).toBeGreaterThan(50);
    expect(filesIn(path.join(clientSrc, "hooks")).length).toBeGreaterThan(20);
  });
});
