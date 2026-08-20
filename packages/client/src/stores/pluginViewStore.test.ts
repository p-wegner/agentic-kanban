import { beforeEach, describe, expect, it } from "vitest";
import { usePluginViewStore } from "./pluginViewStore.js";

function reset() {
  usePluginViewStore.setState({ selection: null, installFocusNonce: 0, projectId: null });
}

describe("pluginViewStore", () => {
  beforeEach(reset);

  it("drops a plugin pick when the active project changes", () => {
    const { setActiveProject, setSelection } = usePluginViewStore.getState();
    setActiveProject("project-a");
    setSelection({ kind: "plugin", slug: "reqextract" });
    expect(usePluginViewStore.getState().selection).toEqual({ kind: "plugin", slug: "reqextract" });

    setActiveProject("project-b");

    // Carried onto another project the slug names a plugin that may not even be
    // installed there, and the panel renders its "adds no views…" state about it.
    expect(usePluginViewStore.getState().selection).toBeNull();
    expect(usePluginViewStore.getState().projectId).toBe("project-b");
  });

  it("keeps the pick when the same project is re-announced", () => {
    const { setActiveProject, setSelection } = usePluginViewStore.getState();
    setActiveProject("project-a");
    setSelection({ kind: "plugin", slug: "reqextract" });
    setActiveProject("project-a");
    expect(usePluginViewStore.getState().selection).toEqual({ kind: "plugin", slug: "reqextract" });
  });

  it("keeps a marketplace pick across a project switch (it is not project-scoped)", () => {
    const { setActiveProject, openMarketplace } = usePluginViewStore.getState();
    setActiveProject("project-a");
    openMarketplace({ focusInstall: true });
    setActiveProject("project-b");
    expect(usePluginViewStore.getState().selection).toEqual({ kind: "marketplace" });
    expect(usePluginViewStore.getState().installFocusNonce).toBe(1);
  });

  it("clears the pick when the project becomes null (no project open)", () => {
    const { setActiveProject, setSelection } = usePluginViewStore.getState();
    setActiveProject("project-a");
    setSelection({ kind: "plugin", slug: "reqextract" });
    setActiveProject(null);
    expect(usePluginViewStore.getState().selection).toBeNull();
  });
});
