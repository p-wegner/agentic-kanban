import { describe, expect, it } from "vitest";
import { isHttpUrl } from "./url.js";

describe("isHttpUrl", () => {
  it("accepts http and https URLs", () => {
    expect(isHttpUrl("http://example.com")).toBe(true);
    expect(isHttpUrl("https://tracker.example.com/browse/PROJ-123")).toBe(true);
  });

  it("rejects non-http(s) schemes used for the external-tracker link", () => {
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("ftp://example.com/file")).toBe(false);
    expect(isHttpUrl("data:text/html,<script>")).toBe(false);
  });

  it("rejects malformed and relative values", () => {
    expect(isHttpUrl("not a url")).toBe(false);
    expect(isHttpUrl("/relative/path")).toBe(false);
    expect(isHttpUrl("")).toBe(false);
  });
});
