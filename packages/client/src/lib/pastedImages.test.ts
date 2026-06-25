import { describe, it, expect, vi } from "vitest";
import { handleImagePaste, mergeDescriptionWithImages } from "./pastedImages.js";

describe("mergeDescriptionWithImages", () => {
  it("returns the trimmed description when there are no images", () => {
    expect(mergeDescriptionWithImages("  hello  ", [])).toBe("hello");
  });

  it("appends each image as numbered markdown after a blank line", () => {
    const out = mergeDescriptionWithImages("desc", ["data:img1", "data:img2"]);
    expect(out).toBe("desc\n\n![screenshot-1](data:img1)\n![screenshot-2](data:img2)");
  });

  it("emits only image markdown when the description is empty", () => {
    expect(mergeDescriptionWithImages("   ", ["data:img1"])).toBe("![screenshot-1](data:img1)");
  });

  it("returns an empty string when both are empty", () => {
    expect(mergeDescriptionWithImages("", [])).toBe("");
  });
});

describe("handleImagePaste", () => {
  function makeEvent(items: Array<Partial<DataTransferItem>> | null) {
    const preventDefault = vi.fn();
    const clipboardData = items === null ? null : ({ items } as unknown as DataTransfer);
    return { e: { clipboardData, preventDefault }, preventDefault };
  }

  it("returns false and does nothing when there is no clipboard data", () => {
    const { e } = makeEvent(null);
    const onImage = vi.fn();
    expect(handleImagePaste(e, onImage)).toBe(false);
    expect(onImage).not.toHaveBeenCalled();
  });

  it("returns false for non-image pastes and does not prevent default", () => {
    const { e, preventDefault } = makeEvent([{ type: "text/plain", getAsFile: () => null }]);
    const onImage = vi.fn();
    expect(handleImagePaste(e, onImage)).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(onImage).not.toHaveBeenCalled();
  });

  it("prevents default and reads an image item as a data URL", async () => {
    // The client test env is node — no DOM FileReader. Stub a minimal one that
    // synchronously fires onload with a fixed data URL.
    class FakeFileReader {
      onload: ((ev: { target: { result: string } }) => void) | null = null;
      readAsDataURL() {
        this.onload?.({ target: { result: "data:image/png;base64,Zm9v" } });
      }
    }
    vi.stubGlobal("FileReader", FakeFileReader);
    try {
      const file = { type: "image/png" } as unknown as File;
      const { e, preventDefault } = makeEvent([{ type: "image/png", getAsFile: () => file }]);
      const onImage = vi.fn();

      expect(handleImagePaste(e, onImage)).toBe(true);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(onImage).toHaveBeenCalledOnce();
      expect(onImage.mock.calls[0][0]).toMatch(/^data:image\/png/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
