import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// #1071: a target-only drive's empty state told the operator to "link a meta/epic issue
// with children to this drive" but offered no action that did it — StartDriveForm only sets
// metaIssueId at creation time, and there was no edit path. The fix adds an "attach an existing
// epic" picker beside the existing "plan this drive" action. Static render only (no jsdom by
// convention) — this asserts the picker exists in the DOM, not that clicking it works.
vi.mock("../lib/api.js", () => ({
  apiFetch: vi.fn(() => Promise.resolve([])),
  apiPost: vi.fn(() => Promise.resolve({})),
  apiPut: vi.fn(() => Promise.resolve({})),
}));

import { DriveScopePlanner } from "../components/DriveScopePlanner.js";

describe("DriveScopePlanner", () => {
  it("offers an attach-existing-epic picker when the drive has no meta issue yet", () => {
    const html = renderToStaticMarkup(
      <DriveScopePlanner
        projectId="proj-1"
        driveId="drive-1"
        hasMetaIssue={false}
        onScoped={() => {}}
      />,
    );
    expect(html).toContain("Attach an existing epic issue");
    expect(html).toContain("Attach epic");
    expect(html).toContain("Plan this drive");
  });

  it("does not offer the attach picker once the drive already has a meta issue", () => {
    const html = renderToStaticMarkup(
      <DriveScopePlanner
        projectId="proj-1"
        driveId="drive-1"
        hasMetaIssue={true}
        onScoped={() => {}}
      />,
    );
    expect(html).not.toContain("Attach an existing epic issue");
    expect(html).toContain("Decompose the epic");
  });
});
