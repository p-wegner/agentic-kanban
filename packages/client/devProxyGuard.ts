import type { IncomingMessage } from "node:http";

/**
 * The dev server's `host` binds to "::" (all interfaces, see vite.config.ts) so the UI is
 * reachable over Tailscale (`allowedHosts: [".ts.net"]`, 73e4bf03fb). The board API behind
 * the `/api`/`/health`/`/ws` proxies has no authentication of its own — its security model
 * assumes "only reachable from this machine" — so exposing the UI widely must not also expose
 * the API. This guard rejects any proxied request whose TCP peer isn't loopback, independent
 * of the UI's bind address (#866).
 */
export function isLoopbackAddress(address: string | undefined | null): boolean {
  if (!address) return false;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/** Vite/webpack-dev-server-style proxy `bypass`: `false` makes vite answer 404 without forwarding. */
export function rejectNonLoopback(req: IncomingMessage): false | undefined {
  return isLoopbackAddress(req.socket?.remoteAddress) ? undefined : false;
}
