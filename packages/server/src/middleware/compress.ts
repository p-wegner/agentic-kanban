import { gzipSync } from "node:zlib";
import type { MiddlewareHandler } from "hono";

/**
 * Conditional gzip for buffered JSON GET responses.
 *
 * Why a custom middleware instead of hono/compress: hono/compress pipes the
 * response body through a `CompressionStream`, which (a) compresses ANY
 * content-type the client accepts — including `text/event-stream`, breaking
 * SSE incremental delivery under @hono/node-server — and (b) streams, so the
 * resulting response has no content-length and bypasses node-server's fast
 * buffered-body path. Every `application/json` response in this server is a
 * fully buffered string/buffer (SSE routes use `text/event-stream`, WebSocket
 * upgrades live under `/ws/*` outside the `/api/*` mount), so a synchronous
 * `gzipSync` on the buffered body is simpler and safe: 172KB gzips in ~1-3ms.
 *
 * Applies ONLY when ALL of:
 *  - method is GET (HEAD/POST/PUT/... pass through untouched),
 *  - the response has a body (204/304/101 etc. pass through untouched),
 *  - Content-Type is application/json (hard-excludes text/event-stream SSE),
 *  - the client sent Accept-Encoding including gzip (with q > 0),
 *  - the body is >= COMPRESS_MIN_BYTES (small responses gain nothing),
 *  - no Content-Encoding has been applied already.
 *
 * ETag is left byte-identical (computed from the uncompressed body by the
 * routes; clients compare it as an opaque token). `Vary: Accept-Encoding` is
 * appended on compressed responses. Content-Length is recomputed to match the
 * compressed body.
 */

/** Responses smaller than this are not worth compressing. */
export const COMPRESS_MIN_BYTES = 4096;

/** True when the Accept-Encoding header allows gzip with a non-zero q-value. */
function acceptsGzip(header: string | undefined): boolean {
  if (!header) return false;
  return header.split(",").some((part) => {
    const [encoding, ...params] = part.trim().split(";");
    if (encoding.trim().toLowerCase() !== "gzip") return false;
    const qParam = params.map((p) => p.trim()).find((p) => p.toLowerCase().startsWith("q="));
    if (!qParam) return true;
    const q = Number(qParam.slice(2));
    return !Number.isFinite(q) || q > 0;
  });
}

/** Append Accept-Encoding to an existing Vary header without duplicating it. */
function withVaryAcceptEncoding(vary: string | null): string {
  if (!vary || vary.trim() === "") return "Accept-Encoding";
  if (vary.trim() === "*") return vary;
  const hasAcceptEncoding = vary
    .split(",")
    .some((v) => v.trim().toLowerCase() === "accept-encoding");
  return hasAcceptEncoding ? vary : `${vary}, Accept-Encoding`;
}

export const jsonGzip: MiddlewareHandler = async (c, next) => {
  await next();

  if (c.req.method !== "GET") return;
  const res = c.res;
  // No buffered body to compress: 204/304/101/HEAD-style responses.
  if (!res || res.body == null) return;
  if (res.status === 204 || res.status === 304 || res.status < 200) return;
  if (res.headers.get("content-encoding")) return;
  const contentType = res.headers.get("content-type");
  // application/json only — hard-excludes text/event-stream (SSE) and any
  // other streaming content type, so we never buffer an incremental response.
  if (!contentType || !contentType.toLowerCase().startsWith("application/json")) return;
  if (!acceptsGzip(c.req.header("accept-encoding"))) return;

  // Every application/json response here is a buffered string/buffer, so this
  // resolves immediately without stalling a stream.
  const raw = Buffer.from(await res.arrayBuffer());
  if (raw.byteLength < COMPRESS_MIN_BYTES) {
    // arrayBuffer() consumed the body — restore an identical response.
    // (`c.res = undefined` first so Hono does not merge stale headers from
    // the consumed response onto the replacement.)
    const headers = new Headers(res.headers);
    const restored = new Response(raw, { status: res.status, headers });
    c.res = undefined;
    c.res = restored;
    return;
  }

  const compressed = gzipSync(raw);
  const headers = new Headers(res.headers);
  headers.set("content-encoding", "gzip");
  // Content-Length must match the compressed body, not the original.
  headers.delete("content-length");
  headers.set("content-length", String(compressed.byteLength));
  headers.set("vary", withVaryAcceptEncoding(headers.get("vary")));
  const compressedRes = new Response(compressed, { status: res.status, headers });
  c.res = undefined;
  c.res = compressedRes;
};
