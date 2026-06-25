// Ratchet gate for the BoardPage decentralisation (#905, parent #895/B).
//
// BoardPage is the board's hottest file precisely because every piece of
// board-shared state lived on it as local `useState`/`useRef` and was
// prop-drilled out. The arch-fix is to move those slices into client stores,
// one slice per PR. Line-count caps can't measure that — *state centrality*
// can. So this gate counts BoardPage's local state hooks and BoardPageView's
// prop surface and caps both.
//
// THE CAP ONLY RATCHETS DOWN. When a future PR moves another slice (filters,
// bulk selection, keyboard cursor) into a store, lower the cap to the new count
// in the same PR. Never raise it: a new `useState` on BoardPage means the slice
// belongs in a store, not on the page.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function countMatches(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

describe("BoardPage state-centrality gate (#905)", () => {
  it("caps BoardPage local state hooks (useState + useRef) — ratchet DOWN only", () => {
    const src = readFileSync(resolve(HERE, "BoardPage.tsx"), "utf8");
    // Call sites only: `useState(` / `useState<` and `useRef(` / `useRef<`.
    // (Bare `useState`/`useRef` words in imports/comments are excluded.)
    const useStateCount = countMatches(src, /useState[<(]/g);
    const useRefCount = countMatches(src, /useRef[<(]/g);
    const total = useStateCount + useRefCount;

    // Baseline after migrating the selection slice (selectedIssue +
    // workspaceIssue/panel-open) off BoardPage in this PR. Down from the
    // pre-#905 count documented on the ticket. Lower this as slices move.
    const CAP = 20;
    expect(
      total,
      `BoardPage has ${total} local state hooks (useState=${useStateCount}, useRef=${useRefCount}). ` +
        `The cap is ${CAP}. Adding board-shared state to BoardPage is a regression — ` +
        `move the slice into a client store (see stores/boardSelectionStore.ts) instead. ` +
        `If you legitimately removed a slice, lower CAP to ${total}.`,
    ).toBeLessThanOrEqual(CAP);
  });

  it("caps the BoardPageView view-model prop surface — ratchet DOWN only", () => {
    const src = readFileSync(resolve(HERE, "../components/BoardPageView.tsx"), "utf8");
    // Count the fields of the BoardPageViewModel interface — the single mega
    // object every prop is Pick<>ed from. Each `^  name:` line (2-space indent,
    // identifier, colon) is one prop on the view's surface.
    const modelStart = src.indexOf("interface BoardPageViewModel {");
    expect(modelStart, "BoardPageViewModel interface not found").toBeGreaterThan(-1);
    const modelEnd = src.indexOf("\n}", modelStart);
    const body = src.slice(modelStart, modelEnd);
    const propCount = countMatches(body, /^ {2}[A-Za-z][\w]*[?]?:/gm);

    // Baseline after the selection slice (10 fields) left the prop surface in
    // this PR. Lower as further slices migrate into stores.
    const CAP = 120;
    expect(
      propCount,
      `BoardPageView's view-model has ${propCount} props; the cap is ${CAP}. ` +
        `Threading more board-shared state through props is the regression #895/B targets — ` +
        `read it from a store via a selector instead. If you removed props, lower CAP to ${propCount}.`,
    ).toBeLessThanOrEqual(CAP);
  });
});
