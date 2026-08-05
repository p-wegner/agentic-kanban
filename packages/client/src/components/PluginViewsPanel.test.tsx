import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PluginViewsPanel, createStartLatch } from "./PluginViewsPanel.js";

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

describe("PluginViewsPanel", () => {
  it("renders the loading state before the surface arrives", () => {
    const html = renderToStaticMarkup(<PluginViewsPanel projectId="project-1" pluginSlug={null} />);
    expect(html).toContain("Loading plugins…");
  });
});
