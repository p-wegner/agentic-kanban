import { describe, expect, it } from "vitest";
import { withViewTabGroupHeaders } from "./viewTabGroups.js";
import { ACTIVITY_TABS, ANALYTICS_TABS, type ViewTabDescriptor } from "./viewTabs.js";

function tab(id: string, group?: string): ViewTabDescriptor {
  return {
    id,
    label: id,
    paletteLabel: id,
    group,
    paletteIcon: "x",
    paletteDescription: id,
  };
}

const headers = (tabs: readonly ViewTabDescriptor[]) =>
  withViewTabGroupHeaders(tabs).map((e) => e.groupHeader);

describe("withViewTabGroupHeaders (#742)", () => {
  it("emits a header before the first tab of each run", () => {
    expect(headers([tab("a", "Flow"), tab("b", "Flow"), tab("c", "Agents"), tab("d", "Agents")]))
      .toEqual(["Flow", undefined, "Agents", undefined]);
  });

  it("emits no header for tabs that declare no group", () => {
    expect(headers([tab("a"), tab("b"), tab("c")])).toEqual([undefined, undefined, undefined]);
  });

  it("keeps every tab, in order, exactly once", () => {
    const tabs = [tab("a", "Flow"), tab("b"), tab("c", "Agents")];
    expect(withViewTabGroupHeaders(tabs).map((e) => e.tab.id)).toEqual(["a", "b", "c"]);
  });

  it("compares against the PREVIOUS tab only, so an ungrouped tab restarts the run", () => {
    // Run-based, not set-based: `Flow` gets a second header after the gap. No
    // ViewTabSet in viewTabs.ts declares interleaved groups, so this pins the
    // tab bar's long-standing behaviour rather than endorsing that shape.
    expect(headers([tab("a", "Flow"), tab("b"), tab("c", "Flow")]))
      .toEqual(["Flow", undefined, "Flow"]);
  });

  it("headers an empty-string group as no group at all", () => {
    // `tab.group &&` is falsy for "", so an empty label never renders a header.
    expect(headers([tab("a", ""), tab("b", "Flow")])).toEqual([undefined, "Flow"]);
  });

  it("returns nothing for no tabs", () => {
    expect(withViewTabGroupHeaders([])).toEqual([]);
  });

  it("gives the real analytics tab set exactly two headers, at the group boundaries", () => {
    expect(headers(ANALYTICS_TABS)).toEqual([
      "Flow", undefined, undefined, "Agents", undefined, undefined, undefined,
    ]);
  });

  it("gives the real activity tab set no headers — none of its tabs is grouped", () => {
    expect(headers(ACTIVITY_TABS)).toEqual(ACTIVITY_TABS.map(() => undefined));
  });
});
