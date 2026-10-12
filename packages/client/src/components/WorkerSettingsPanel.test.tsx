import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkerSettingsPanel } from "./WorkerSettingsPanel.js";

vi.mock("../hooks/useWorkerFleetQueries.js", () => ({ saveWorkerSettings: vi.fn() }));

const props = {
  workerId: "w1", maxConcurrency: 2, labels: ["linux"], providers: ["claude"],
  projects: [{ id: "p1", name: "Alpha" }], onSaved: () => {},
};

describe("WorkerSettingsPanel (#1381)", () => {
  it("seeds the form from the worker's current values and lists projects", () => {
    const html = renderToStaticMarkup(<WorkerSettingsPanel {...props} />);
    expect(html).toContain('value="2"');
    expect(html).toContain('value="linux"');
    expect(html).toContain("Alpha");
    expect(html).not.toContain("pinned by flag");
  });

  it("prefers what the board already holds over what the worker reports", () => {
    const html = renderToStaticMarkup(
      <WorkerSettingsPanel {...props} desiredSettings={{ rev: "r1", settings: { maxConcurrency: 7, labels: ["gpu"] } }} settingsReport={{ pinned: [], appliedRev: "r1" }} />,
    );
    expect(html).toContain('value="7"');
    expect(html).toContain('value="gpu"');
    expect(html).not.toContain("waiting for the worker");
  });

  it("shows a flag-pinned value read-only", () => {
    const html = renderToStaticMarkup(<WorkerSettingsPanel {...props} settingsReport={{ pinned: ["maxConcurrency"] }} />);
    expect(html).toContain("pinned by flag");
    expect(html).toMatch(/<input[^>]*disabled=""[^>]*value="2"|<input[^>]*value="2"[^>]*disabled=""/);
    expect(html).not.toMatch(/<input[^>]*disabled=""[^>]*value="linux"|<input[^>]*value="linux"[^>]*disabled=""/);
  });

  it("says when the worker has not applied the latest push", () => {
    const html = renderToStaticMarkup(
      <WorkerSettingsPanel {...props} desiredSettings={{ rev: "r2", settings: { maxConcurrency: 3 } }} settingsReport={{ pinned: [], appliedRev: "r1" }} />,
    );
    expect(html).toContain("waiting for the worker to apply");
  });
});
