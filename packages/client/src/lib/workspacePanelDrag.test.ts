import { describe, expect, it } from "vitest";
import {
  classifyDragSnap,
  computeModalEntryPosition,
  EDGE_SNAP_THRESHOLD,
  SNAP_PREVIEW_THRESHOLD,
} from "./workspacePanelDrag.js";

describe("computeModalEntryPosition", () => {
  it("jumps a left-docked panel to the fixed inset, clamped on-screen", () => {
    expect(computeModalEntryPosition("left", 0, 100, 1600)).toEqual({ x: 200, y: 140 });
  });

  it("keeps a right-docked panel under the cursor (panelX - 10)", () => {
    // Wide window so maxX (2400-1200=1200) doesn't clamp panelX-10 = 890.
    expect(computeModalEntryPosition("right", 900, 50, 2400)).toEqual({ x: 890, y: 90 });
  });

  it("clamps x so the modal never overflows the right edge", () => {
    // modalWidth = min(1200, 1000*0.96=960) = 960 -> maxX = 1000 - 960 = 40
    expect(computeModalEntryPosition("right", 5000, 0, 1000)).toEqual({ x: 40, y: 40 });
  });

  it("never returns a negative y", () => {
    expect(computeModalEntryPosition("right", 100, -200, 1600).y).toBe(0);
  });
});

describe("classifyDragSnap", () => {
  const W = 1000;
  const PW = 400;

  it("commits to a right snap within the edge threshold", () => {
    const x = W - PW - (EDGE_SNAP_THRESHOLD - 1); // right edge inside threshold
    expect(classifyDragSnap(x, PW, W)).toBe("snap-right");
  });

  it("commits to a left snap within the edge threshold", () => {
    expect(classifyDragSnap(EDGE_SNAP_THRESHOLD - 1, PW, W)).toBe("snap-left");
  });

  it("shows a right preview in the wider band", () => {
    const x = W - PW - (SNAP_PREVIEW_THRESHOLD - 1);
    expect(classifyDragSnap(x, PW, W)).toBe("preview-right");
  });

  it("shows a left preview in the wider band", () => {
    expect(classifyDragSnap(SNAP_PREVIEW_THRESHOLD - 1, PW, W)).toBe("preview-left");
  });

  it("returns none in the free-movement middle", () => {
    expect(classifyDragSnap(W / 2 - PW / 2, PW, W)).toBe("none");
  });

  it("prefers a right snap over a left snap when both edges are near (narrow window)", () => {
    // Panel wider than the gap: both edges within threshold; right is tested first.
    expect(classifyDragSnap(0, W, W)).toBe("snap-right");
  });
});
