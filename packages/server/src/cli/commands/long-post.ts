import http from "node:http";

export interface LongPostAnswer { status: number; statusText: string; body: string }

/**
 * POST JSON with NO client-side response timeout (#1670). Node's `fetch` (undici) gives up
 * after a 300 s headers timeout, but the merge route stays open for the whole pre-merge gate
 * (30-45 min). `node:http` has no default response timeout, and `agent: false` +
 * `Connection: close` keeps the CLI's `process.exit` clean (see board-server-writes.ts).
 */
export function postJsonNoTimeout(url: string, payload: unknown): Promise<LongPostAnswer> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(url, {
      method: "POST",
      agent: false,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        Connection: "close",
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        statusText: res.statusMessage ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(data);
  });
}
