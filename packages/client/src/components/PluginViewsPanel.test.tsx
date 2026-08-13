import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PluginViewsPanel, createStartLatch, splitByAudience } from "./PluginViewsPanel.js";

describe("createStartLatch (#251 staleness guard)", () => {
  it("drops the response of a superseded start", () => {
    const latch = createStartLatch();
    latch.begin("reqextract:graph"); // click A — slow cold spawn
    latch.begin("reqextract:matrix"); // click B — already running, resolves first

    // A's late response must not touch the pane: the header already shows B.
    expect(latch.isCurrent("reqextract:graph")).toBe(false);
    expect(latch.isCurrent("reqextract:matrix")).toBe(true);
  });

  it("keeps the starting flag owned by the newest start", () => {
    const latch = createStartLatch();
    latch.begin("p:a");
    latch.begin("p:b");

    // A's `finally` runs first and must be a no-op — clearing the flag here would
    // hide B's "Starting…" state while B is still launching.
    if (latch.isCurrent("p:a")) latch.end("p:a");
    expect(latch.isCurrent("p:b")).toBe(true);

    if (latch.isCurrent("p:b")) latch.end("p:b");
    expect(latch.isCurrent("p:b")).toBe(false);
  });

  it("applies the response when nothing else was selected in the meantime", () => {
    const latch = createStartLatch();
    latch.begin("p:only");
    expect(latch.isCurrent("p:only")).toBe(true);
    latch.end("p:only");
    expect(latch.isCurrent("p:only")).toBe(false);
  });

  it("re-selecting the same view re-claims the latch", () => {
    const latch = createStartLatch();
    latch.begin("p:a");
    latch.begin("p:b");
    latch.begin("p:a"); // user went back to A while both were in flight
    expect(latch.isCurrent("p:a")).toBe(true);
    expect(latch.isCurrent("p:b")).toBe(false);
  });

  it("survives the documented interleaving end-to-end", () => {
    const latch = createStartLatch();
    const applied: string[] = [];
    // start(A) … start(B) … B resolves … A resolves
    latch.begin("p:a");
    latch.begin("p:b");
    if (latch.isCurrent("p:b")) applied.push("p:b");
    if (latch.isCurrent("p:a")) applied.push("p:a");
    expect(applied).toEqual(["p:b"]);
  });
});

describe("splitByAudience (#456 rail weighting)", () => {
  it("treats an unmarked entry as operator — a pre-#456 manifest renders unchanged", () => {
    const items = [{ name: "a" }, { name: "b" }, { name: "c" }];
    const { operator, developer } = splitByAudience(items);
    expect(operator.map((i) => i.name)).toEqual(["a", "b", "c"]);
    expect(developer).toEqual([]);
  });

  it("collapses only the entries explicitly marked developer", () => {
    // The measured pm-pipeline rail: one workflow script among diagnostics.
    const scripts = [
      { name: "status", audience: "operator" as const },
      { name: "plan-dry-run", audience: "developer" as const },
      { name: "selftest", audience: "developer" as const },
    ];
    const { operator, developer } = splitByAudience(scripts);
    expect(operator.map((s) => s.name)).toEqual(["status"]);
    expect(developer.map((s) => s.name)).toEqual(["plan-dry-run", "selftest"]);
  });

  it("keeps each half in manifest order", () => {
    const items = [
      { id: "1", audience: "developer" as const },
      { id: "2" },
      { id: "3", audience: "developer" as const },
      { id: "4", audience: "operator" as const },
    ];
    const { operator, developer } = splitByAudience(items);
    expect(operator.map((i) => i.id)).toEqual(["2", "4"]);
    expect(developer.map((i) => i.id)).toEqual(["1", "3"]);
  });

  it("tolerates a null audience (older server sends the field as null)", () => {
    const { operator, developer } = splitByAudience([{ id: "x", audience: null }]);
    expect(operator).toHaveLength(1);
    expect(developer).toHaveLength(0);
  });
});

describe("PluginViewsPanel", () => {
  it("renders the loading state before the surface arrives", () => {
    const html = renderToStaticMarkup(<PluginViewsPanel projectId="project-1" pluginSlug={null} />);
    expect(html).toContain("Loading plugins…");
  });
});
