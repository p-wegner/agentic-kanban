import { describe, it, expect } from "vitest";
import { markdownUrlTransform, isRenderableImageDataUrl } from "./markdownUrlTransform.js";
import { mergeDescriptionWithImages } from "./pastedImages.js";

/** The shape react-markdown passes as the third argument. */
const img = { tagName: "img" } as never;
const anchor = { tagName: "a" } as never;

describe("markdownUrlTransform", () => {
  describe("the #941 regression: a pasted screenshot must survive", () => {
    it("keeps a base64 PNG data URI on an image src", () => {
      const url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
      expect(markdownUrlTransform(url, "src", img)).toBe(url);
    });

    it("keeps exactly what the paste flow writes", () => {
      // Couples this guard to the real producer: if pastedImages.ts ever changes
      // the URI it emits, this fails rather than silently passing on a stale shape.
      const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
      const markdown = mergeDescriptionWithImages("desc", [dataUrl]);
      const embedded = /!\[screenshot-1\]\((.+)\)/.exec(markdown)?.[1];
      expect(embedded).toBe(dataUrl);
      expect(markdownUrlTransform(embedded!, "src", img)).toBe(dataUrl);
    });

    it.each(["png", "jpeg", "jpg", "gif", "webp", "avif", "bmp"])(
      "keeps a %s data URI",
      (subtype) => {
        const url = `data:image/${subtype};base64,AAAA`;
        expect(markdownUrlTransform(url, "src", img)).toBe(url);
      },
    );

    it("keeps a data URI with no explicit base64 marker", () => {
      const url = "data:image/gif,GIF89a";
      expect(markdownUrlTransform(url, "src", img)).toBe(url);
    });
  });

  describe("still sanitises everything react-markdown would", () => {
    it("blocks a scripted javascript: href", () => {
      expect(markdownUrlTransform("javascript:alert(1)", "href", anchor)).toBe("");
    });

    it("blocks data:text/html even on an image src", () => {
      expect(
        markdownUrlTransform("data:text/html,<script>alert(1)</script>", "src", img),
      ).toBe("");
    });

    it("blocks scriptable SVG, which can carry <script> and event handlers", () => {
      expect(markdownUrlTransform("data:image/svg+xml;base64,PHN2Zz4=", "src", img)).toBe("");
    });

    it("blocks an image data URI used as a navigation target", () => {
      // `href` is navigation, not rendering — a data URI there is same-origin
      // content, so the allowance is deliberately scoped to `src` on an `img`.
      expect(markdownUrlTransform("data:image/png;base64,AAAA", "href", anchor)).toBe("");
    });

    it("blocks an image data URI on a non-img element's src", () => {
      const iframe = { tagName: "iframe" } as never;
      expect(markdownUrlTransform("data:image/png;base64,AAAA", "src", iframe)).toBe("");
    });

    it("passes ordinary URLs straight through", () => {
      expect(markdownUrlTransform("https://example.com/a.png", "src", img)).toBe(
        "https://example.com/a.png",
      );
      expect(markdownUrlTransform("/relative/a.png", "src", img)).toBe("/relative/a.png");
      expect(markdownUrlTransform("mailto:a@b.c", "href", anchor)).toBe("mailto:a@b.c");
    });
  });
});

describe("isRenderableImageDataUrl", () => {
  it("rejects a subtype that merely starts with an allowed one", () => {
    // `image/pngx` must not pass on a prefix match.
    expect(isRenderableImageDataUrl("data:image/pngx;base64,AAAA")).toBe(false);
  });

  it("rejects a non-data URL that mentions an image type", () => {
    expect(isRenderableImageDataUrl("https://e.com/data:image/png;base64,AAAA")).toBe(false);
  });

  it("is case-insensitive, as data URIs are", () => {
    expect(isRenderableImageDataUrl("DATA:IMAGE/PNG;BASE64,AAAA")).toBe(true);
  });

  it("rejects an empty or bare value", () => {
    expect(isRenderableImageDataUrl("")).toBe(false);
    expect(isRenderableImageDataUrl("data:image/png")).toBe(false);
  });
});
