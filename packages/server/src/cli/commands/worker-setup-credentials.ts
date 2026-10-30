import { accessSync, constants, readFileSync } from "node:fs";
import { join } from "node:path";
import { readOAuthCredentials } from "../../lib/oauth-quota-core.js";
import type { WorkerHarness } from "../../worker/worker-harness.js";
import type { AuthProvider } from "./worker-auth-command.js";

/** Is there a usable login for this provider in the worker's own config (a stored token counts)? */
export function hasCredential(harness: WorkerHarness, provider: AuthProvider, nowMs: number): boolean {
  const token = provider === "claude" ? harness.tokenStatus(provider, nowMs) : undefined;
  if (token?.stored && !token.expired) return true;
  const dir = harness.dirFor(provider);
  if (!dir) return false;
  if (provider === "claude") {
    const read = readOAuthCredentials(dir, nowMs);
    // An expired access token with a refresh token is still a login: claude refreshes it itself.
    return read.err === undefined || (read.err === "expired" && hasRefreshToken(dir));
  }
  return probeFile(join(dir, "auth.json"));
}

function hasRefreshToken(dir: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, ".credentials.json"), "utf8").replace(/^\uFEFF/, ""));
    const token = (parsed as { claudeAiOauth?: { refreshToken?: unknown } } | null)?.claudeAiOauth?.refreshToken;
    return typeof token === "string" && token.length > 0;
  } catch {
    return false;
  }
}

function probeFile(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
