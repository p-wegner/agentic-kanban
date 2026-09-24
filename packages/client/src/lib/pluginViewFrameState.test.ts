import { describe, expect, it } from "vitest";
import {
  initialPluginViewFrameState,
  reducePluginViewFrameState,
  type PluginViewFrameState,
} from "./pluginViewFrameState.js";

describe("reducePluginViewFrameState (#1228 overlay lifecycle)", () => {
  it("starts loading", () => {
    expect(initialPluginViewFrameState).toEqual({ status: "loading", url: null });
  });

  it("src-set begins loading for the new url", () => {
    const s = reducePluginViewFrameState(initialPluginViewFrameState, { type: "src-set", url: "http://a" });
    expect(s).toEqual({ status: "loading", url: "http://a" });
  });

  it("frame-loaded for the current url clears the overlay", () => {
    let s: PluginViewFrameState = { status: "loading", url: "http://a" };
    s = reducePluginViewFrameState(s, { type: "frame-loaded", url: "http://a" });
    expect(s).toEqual({ status: "loaded", url: "http://a" });
  });

  it("frame-loaded for a stale (superseded) url is dropped", () => {
    const s: PluginViewFrameState = { status: "loading", url: "http://b" };
    const next = reducePluginViewFrameState(s, { type: "frame-loaded", url: "http://a" });
    expect(next).toBe(s);
  });

  it("timeout while still loading shows the retry notice", () => {
    const s: PluginViewFrameState = { status: "loading", url: "http://a" };
    const next = reducePluginViewFrameState(s, { type: "timeout", url: "http://a" });
    expect(next).toEqual({ status: "timed-out", url: "http://a" });
  });

  it("timeout for a stale url is dropped", () => {
    const s: PluginViewFrameState = { status: "loading", url: "http://b" };
    const next = reducePluginViewFrameState(s, { type: "timeout", url: "http://a" });
    expect(next).toBe(s);
  });

  it("a timeout that arrives after the frame already loaded is a no-op", () => {
    const s: PluginViewFrameState = { status: "loaded", url: "http://a" };
    const next = reducePluginViewFrameState(s, { type: "timeout", url: "http://a" });
    expect(next).toBe(s);
  });

  it("start-failed shows the retry notice with no url", () => {
    const s: PluginViewFrameState = { status: "loading", url: "http://a" };
    const next = reducePluginViewFrameState(s, { type: "start-failed" });
    expect(next).toEqual({ status: "start-failed", url: null });
  });

  it("retry resets to loading with no url (a fresh src-set follows)", () => {
    const s: PluginViewFrameState = { status: "timed-out", url: "http://a" };
    const next = reducePluginViewFrameState(s, { type: "retry" });
    expect(next).toEqual({ status: "loading", url: null });
  });
});
