/**
 * Guard against invalid-UTF-8 strings reaching the libsql driver (arch-review #960).
 *
 * libsql's Rust binding PANICS the whole process (`Utf8Error`, `value.rs:237`) when
 * it re-encodes a JS string that is not valid Unicode text — a lone (unpaired)
 * surrogate. Node's `Buffer.toString("utf8")` never produces invalid *bytes*, but
 * decoding a chunk that ends mid-codepoint (a raw pipe/file read at an arbitrary
 * byte offset, not a codepoint boundary) truncates a multi-byte sequence, and if the
 * missing continuation bytes never arrive as expected (e.g. two independently
 * decoded chunks straddling the split), the JS string can end up carrying an
 * unpaired surrogate — valid as a JS string, invalid as UTF-8. That value survives
 * every JS operation (comparison, `JSON.stringify`, DB round-trip) but crashes the
 * moment libsql tries to encode it back to bytes on write or decode it back to text
 * on read.
 *
 * `sanitizeUtf8` replaces every lone surrogate with U+FFFD so the resulting string
 * is well-formed and safe to persist. Call it at the point raw process/file bytes
 * become a string that will be written to the DB (session_messages.data,
 * sessions.stats), not on every string in the codebase.
 */

const LONE_SURROGATE = /[\uD800-\uDFFF]/g;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Return `value` with every unpaired (lone) surrogate replaced by U+FFFD, leaving
 * valid surrogate pairs untouched. Cheap no-op (single regex test, no allocation)
 * for the overwhelming majority of strings that contain no surrogates at all.
 */
export function sanitizeUtf8(value: string): string {
  if (!LONE_SURROGATE.test(value)) return value;
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (isHighSurrogate(code) && i + 1 < value.length && isLowSurrogate(value.charCodeAt(i + 1))) {
      out += value[i] + value[i + 1];
      i++;
    } else if (isHighSurrogate(code) || isLowSurrogate(code)) {
      out += "�";
    } else {
      out += value[i];
    }
  }
  return out;
}
