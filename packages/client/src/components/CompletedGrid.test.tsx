import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { CompletedTruncationNotice } from "./CompletedGrid.js";

describe("CompletedTruncationNotice (#1540)", () => {
  it("renders nothing when every completed issue is listed", () => {
    expect(renderToStaticMarkup(<CompletedTruncationNotice shown={64} total={64} searching={false} />)).toBe("");
  });

  it("says newest N of M and points to List view when truncated", () => {
    const html = renderToStaticMarkup(<CompletedTruncationNotice shown={64} total={1506} searching={false} />).replace(/<!-- -->/g, "");
    expect(html).toContain("newest 64 of 1506");
    expect(html).toContain("List view");
    expect(html).not.toContain("search only covers");
  });

  it("warns that search only covers the loaded issues", () => {
    const html = renderToStaticMarkup(<CompletedTruncationNotice shown={64} total={1506} searching />);
    expect(html).toContain("search only covers");
  });
});
