// @gate:always-run — scans components/ and reads the registry; imports only what it asserts.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PANEL_CLOSE_ORDER, PANEL_IDS, closePropFor, showPropFor } from "../lib/panelRegistry.js";

/**
 * The panel registry is the single list (#588).
 *
 * Board views have had a registry since #446; panels were 19 hand-wired
 * `showX`/`setShowX`/`onCloseX` quadruplets across four files, so adding one meant editing
 * all four and forgetting one was silent.
 */
const clientSrc = path.join(import.meta.dirname!, "..");
const read = (p: string) => fs.readFileSync(p, "utf8");

describe("panel registry (#588)", () => {
  it("has no duplicate ids", () => {
    expect(new Set(PANEL_IDS).size).toBe(PANEL_IDS.length);
  });

  it("every close-order entry is a registered panel", () => {
    // The order is a subset (some panels own their own dismissal) but never a superset —
    // an id here that is not in PANEL_IDS would silently never match.
    const ids = new Set<string>(PANEL_IDS);
    const strays = PANEL_CLOSE_ORDER.filter((id) => !ids.has(id));
    expect(strays, `close order names unregistered panels: ${strays.join(", ")}`).toEqual([]);
  });

  it("the close order is itself duplicate-free", () => {
    expect(new Set(PANEL_CLOSE_ORDER).size).toBe(PANEL_CLOSE_ORDER.length);
  });

  it("`useBoardPanels` declares no per-panel useState — the registry is the list", () => {
    // The acceptance criterion, asserted rather than asserted-in-a-commit-message: 19
    // `useState(false)` calls became one `useState<ReadonlySet<PanelId>>`.
    const src = read(path.join(clientSrc, "hooks", "useBoardPanels.ts"));
    const perPanelState = src.match(/useState\(false\)/g) ?? [];
    expect(perPanelState, "per-panel boolean state is what the registry replaces").toEqual([]);
    expect(src).toContain("ReadonlySet<PanelId>");
  });

  it("every registered panel is actually wired to a renderer", () => {
    // The half that used to be forgotten: a panel with state but no render, or renamed in
    // one file and not the other.
    //
    // Two files, because the wiring is genuinely split: most panels render in
    // `BoardOverlayPanels`, but `liveActivityTicker` renders inline in `BoardPageView`. That
    // split is a real inconsistency and worth collapsing one day — asserting it away by
    // scanning only one file would have hidden it instead.
    const wiring = ["components/BoardOverlayPanels.tsx", "components/BoardPageView.tsx"]
      .map((p) => read(path.join(clientSrc, p)))
      .join("\n");
    const missing = PANEL_IDS.filter(
      (id) => !wiring.includes(showPropFor(id)) && !wiring.includes(closePropFor(id)),
    );
    expect(
      missing,
      `registered but never rendered: ${missing.join(", ")}. Either wire it or drop it from PANEL_IDS.`,
    ).toEqual([]);
  });
});
