import http from "node:http";
import { afterEach, expect, it } from "vitest";
import { postJsonNoTimeout } from "./long-post.js";

let server: http.Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

it("waits for a slow route and returns the real verdict (no fetch failed)", async () => {
  server = http.createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ mergeOutput: "landed" }));
    }, 300);
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const ans = await postJsonNoTimeout(`http://127.0.0.1:${port}/x`, {});
  expect(ans.status).toBe(200);
  expect(JSON.parse(ans.body).mergeOutput).toBe("landed");
});
