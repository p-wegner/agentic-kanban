import { defaultUrlTransform, type UrlTransform } from "react-markdown";

/**
 * URL transform for markdown that may embed a pasted screenshot (#941).
 *
 * `pastedImages.ts` appends a pasted screenshot to a description as
 * `![screenshot-N](data:image/png;base64,...)` — that is the board's own paste
 * contract, written by the create-issue forms and the detail-panel edit flow.
 * But react-markdown's `defaultUrlTransform` allows only `http(s)`, `irc(s)`,
 * `mailto` and `xmpp`; every other protocol is rewritten to `""`. So the image
 * the board had just written came back as `<img src="">` and the attachment was
 * invisible in ticket details — the description looked like it had silently lost
 * the screenshot.
 *
 * The fix is NOT to drop the transform. `data:` is an XSS vector in general:
 * `data:text/html,<script>…</script>` in an `href` is same-origin script
 * execution, and SVG is scriptable too. So this allows exactly the shape the
 * paste flow produces — a raster image data URI — and delegates every other URL,
 * including any other `data:`, to react-markdown's own sanitiser.
 */

/**
 * Raster image data URIs only.
 *
 * - `image/svg+xml` is deliberately excluded: an SVG can carry `<script>` and
 *   event handlers, so rendering one from untrusted markdown is script
 *   execution. The paste flow reads a clipboard bitmap, so it never produces one.
 * - The subtype list is an allowlist rather than `image/[a-z]+` so a future
 *   scriptable image type cannot slip in by default.
 */
const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|jpg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)[,;]/i;

/**
 * True when `value` is a data URI holding a non-scriptable raster image.
 *
 * Exported for the guard test, which asserts the scriptable cases stay out.
 */
export function isRenderableImageDataUrl(value: string): boolean {
  return IMAGE_DATA_URL.test(value);
}

/**
 * `urlTransform` for `<ReactMarkdown>` on surfaces that render user-authored
 * issue text (description, description preview, comments).
 *
 * Passes through raster image data URIs on `src`; everything else — including a
 * `data:` URI in an `href`, and any non-image or scriptable `data:` — falls
 * through to `defaultUrlTransform`.
 */
export const markdownUrlTransform: UrlTransform = (url, key, node) => {
  // Only ever on an image's own source. An `href` is a navigation target, so a
  // data URI there stays blocked even when it claims to be an image.
  if (key === "src" && node.tagName === "img" && isRenderableImageDataUrl(url)) {
    return url;
  }
  return defaultUrlTransform(url);
};
