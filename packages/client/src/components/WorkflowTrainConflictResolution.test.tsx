import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkflowRiskPostureSection } from "./WorkflowSections.js";
import type { Settings } from "../lib/settings-shared.js";

const PID = "0b3f1a2c-4d5e-6789-abcd-ef0123456789";
const render = (settings: Record<string, string>) =>
  renderToStaticMarkup(<WorkflowRiskPostureSection settings={settings as unknown as Settings} set={vi.fn() as never} setBool={vi.fn() as never} activeProjectId={PID} />);

describe("train member-conflict setting in the risk posture menu (#1711)", () => {
  it("shows a select with the three options, defaulting to the shepherd, with a one-line explanation", () => {
    const html = render({});
    expect(html).toContain('data-testid="train-conflict-resolution-select"');
    expect(html).toMatch(/<option value="shepherd" selected="">/);
    expect(html).toContain('value="defer"');
    expect(html).toContain('value="author"');
    expect(html).toMatch(/data-testid="train-conflict-resolution-hint"[^>]*>[^<]*train shepherd/);
  });

  it("reflects a stored value and its explanation", () => {
    const html = render({ [`merge_train_conflict_resolution_${PID}`]: "defer" });
    expect(html).toMatch(/<option value="defer" selected="">/);
    expect(html).toMatch(/data-testid="train-conflict-resolution-hint"[^>]*>[^<]*waits for the next train/);
  });
});
