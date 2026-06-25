// Run/smoke verification harness derived from the stack profile (#791; #911 split).
//
// Project-agnostic "does it boot and respond/render" check, derived entirely from the
// profile. Re-exported byte-identically through ../stack-profile.service.ts.

import type { StackProfile, SmokeCheck } from "@agentic-kanban/shared";

/** Resolve the health URL to poll, from an explicit URL or a known dev port. */
function resolveHealthUrl(profile: StackProfile): string | null {
  if (profile.devHealthUrl && profile.devHealthUrl.trim()) return profile.devHealthUrl.trim();
  if (profile.devPort && profile.devPort > 0) return `http://127.0.0.1:${profile.devPort}`;
  return null;
}

/**
 * Build the generalized "does it boot and respond/render" smoke check from a stack profile (#791).
 *
 * This is the project-agnostic successor to the hand-rolled `frontend-smoke.ps1`: the WHAT
 * (dev command, health URL, render assertions) all comes from the profile, nothing is hard-coded
 * to a particular repo. Runs as part of review for web/service projects.
 *
 * Returns `null` — a clean no-op — when the project is not a web/service project, or lacks a dev
 * command or a resolvable health URL. So a CLI/library project skips the smoke step entirely;
 * only something that can actually be booted and hit over HTTP gets checked.
 *
 * Assertions are intentionally generic: an HTTP-200 plus, for an HTML UI, that the rendered body
 * is non-trivially present (we assert on a couple of universal HTML tokens rather than any
 * app-specific text, since the harness can't know a toy project's copy). A service with no HTML
 * passes on the 200 alone.
 */
export function buildSmokeCheck(profile: StackProfile | null): SmokeCheck | null {
  if (!profile || !profile.isWeb) return null;
  if (!profile.devCommand || !profile.devCommand.trim()) return null;
  const healthUrl = resolveHealthUrl(profile);
  if (!healthUrl) return null;

  // Render assertion: for a browser UI the served document contains an <html>/<body> shell.
  // Asserting on these universal tokens (not app-specific copy) keeps the check generic across
  // any web toy-project. A non-browser HTTP service still passes on the 200 with no body needle.
  return {
    devCommand: profile.devCommand.trim(),
    healthUrl,
    expectBodyContains: isLikelyBrowserStack(profile) ? ["<html", "<body"] : [],
  };
}

/** Heuristic: does the dev command serve a browser-rendered UI (vs a headless HTTP API)? */
function isLikelyBrowserStack(profile: StackProfile): boolean {
  const cmd = (profile.devCommand ?? "").toLowerCase();
  // Vite/Next/Angular/CRA dev servers serve an HTML document; bare API servers (express/hono on
  // a JSON route) typically don't. Asserting <html> only when we're confident it's served avoids
  // false negatives on a pure-JSON service.
  return /\bvite\b|\bnext\b|\bng serve\b|react-scripts|\bnuxt\b|\bastro\b|\bremix\b|\bsvelte/.test(cmd);
}
