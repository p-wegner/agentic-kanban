import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsPanel } from "../components/SettingsPanel.js";
import { TABS } from "../components/SettingsPanel.shared.js";

/**
 * The client has no jsdom by design (#782), so this is a static render: `useEffect` never
 * runs, which is exactly the first-paint state — `loading` true, no data fetched. That is a
 * narrow but real assertion for a 668-line component with eleven tab modules behind it: it is
 * the only automated check that `SettingsPanel` and its whole import graph can be constructed
 * at all, and that the eleven tabs the registry declares are the eleven the chrome renders.
 *
 * It deliberately does NOT try to drive the panel. Tab switching, saving and the fetch ladder
 * need a mounted component; the LOGIC those fixes kept landing in was extracted to
 * `lib/settingsPanelState.ts` and is tested there instead of behind a browser harness.
 *
 * Lives in `__tests__/` rather than beside the component because #782's file scope did not
 * include adding files to `components/`; the fixture builders it is paired with are here too.
 */
describe("SettingsPanel (static first paint)", () => {
  const html = renderToStaticMarkup(<SettingsPanel onClose={() => {}} activeProjectId="project-1" />);

  it("renders the modal chrome", () => {
    expect(html).toContain("Settings");
    expect(html).toContain("Changes apply to new agent sessions only.");
    expect(html).toContain(">Save<");
    expect(html).toContain(">Cancel<");
  });

  it("renders a tab button for every registered tab, and nothing else", () => {
    const rendered = [...html.matchAll(/data-testid="settings-tab-([a-z]+)"/g)].map((m) => m[1]);
    expect(rendered).toEqual(TABS.map((t) => t.id));
    for (const tab of TABS) expect(html).toContain(tab.label);
  });

  it("shows the loading state before any data has landed, and no tab body", () => {
    // Effects have not run, so the panel must render its spinner rather than an empty
    // Agent tab built from DEFAULT_SETTINGS — an empty-looking form is worse than a wait.
    expect(html).toContain("Loading...");
  });

  it("renders with no active project, the state a fresh install starts in", () => {
    // Mutation: index the allowlist pref with `activeProjectId` unguarded — this render
    // throws instead of showing the panel.
    const noProject = renderToStaticMarkup(<SettingsPanel onClose={() => {}} activeProjectId={null} />);
    expect(noProject).toContain("Loading...");
    expect(noProject).toContain('data-testid="settings-tab-agent"');
  });
});
