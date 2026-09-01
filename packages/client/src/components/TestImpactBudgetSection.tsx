import type { Dispatch, SetStateAction } from "react";
import { isValidTestImpactBudget } from "@agentic-kanban/shared/lib/test-impact-budget";
import { CollapsibleSection, type ProjectSettingsState } from "./SettingsPanel.shared.js";

/**
 * The Project tab's "Test-impact budget" field (#966).
 *
 * Its own component rather than another block inside `ProjectSettings` — that component is
 * already on the client nloc ring's shrink-only list, and every sibling section here
 * (`ProjectScriptsSettingsSection`, `StackProfileSettingsSection`, `DriveSettingsSection`) is
 * a file for the same reason.
 */
export function TestImpactBudgetSection({ projectSettings, setProjectSettings }: {
  projectSettings: ProjectSettingsState;
  setProjectSettings: Dispatch<SetStateAction<ProjectSettingsState>>;
}) {
  const configured = !!projectSettings.testImpactBudget.trim();
  const valid = isValidTestImpactBudget(projectSettings.testImpactBudget);
  return (
    <CollapsibleSection title="Test-impact budget" configured={configured} defaultOpen={configured}>
      <p className="text-xs text-gray-500">
        A wall-clock ceiling on the tests a merge gate and this project&apos;s builders spend
        (e.g. <code>60s</code>). Setting it turns the change-aware test-impact selector ON for
        both: only the highest-scoring suites that fit the budget run. <strong>Empty = off</strong>,
        which is the default and runs today&apos;s full/scoped verification unchanged.
      </p>
      <p className="text-xs text-amber-700">
        This WEAKENS verification: what it drops is a ranked guess, not a proven non-dependency.
        Every gate message names the budget and how many suites it dropped, so the trade stays visible.
      </p>
      <input
        type="text"
        value={projectSettings.testImpactBudget}
        onChange={(e) => setProjectSettings(s => ({ ...s, testImpactBudget: e.target.value }))}
        placeholder="60s (empty = off)"
        className={`w-full text-sm border rounded px-2 py-1.5 focus:outline-none focus:ring-1 font-mono ${
          valid ? "border-gray-300 focus:ring-brand-500" : "border-red-400 focus:ring-red-500"
        }`}
      />
      {!valid && (
        <p className="text-xs text-red-600">
          Expected e.g. <code>60s</code>, <code>90000ms</code> or <code>2m</code> — a bare number is milliseconds.
        </p>
      )}
    </CollapsibleSection>
  );
}
