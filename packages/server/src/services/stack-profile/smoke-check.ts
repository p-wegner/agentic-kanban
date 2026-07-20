// Run/smoke verification harness derived from the stack profile (#791; #911 split).
//
// Project-agnostic "does it boot and respond/render" check, derived entirely from the
// profile. Re-exported byte-identically through ../stack-profile.service.ts.

import type { StackProfile, SmokeCheck } from "@agentic-kanban/shared";

/**
 * Resolve the health URL to poll, from an explicit URL or a known dev port.
 *
 * `explicit` distinguishes "the user named a real health route" from "we guessed the root URL
 * off the dev port" — only the latter may be graded leniently (#121).
 */
function resolveHealthUrl(profile: StackProfile): { url: string; explicit: boolean } | null {
  if (profile.devHealthUrl && profile.devHealthUrl.trim())
    return { url: profile.devHealthUrl.trim(), explicit: true };
  if (profile.devPort && profile.devPort > 0)
    return { url: `http://127.0.0.1:${profile.devPort}`, explicit: false };
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
  const health = resolveHealthUrl(profile);
  if (!health) return null;

  // Render assertion: for a browser UI the served document contains an <html>/<body> shell.
  // Asserting on these universal tokens (not app-specific copy) keeps the check generic across
  // any web toy-project. A non-browser HTTP service still passes on the 200 with no body needle.
  const expectBodyContains = isLikelyBrowserStack(profile) ? ["<html", "<body"] : [];

  return {
    devCommand: profile.devCommand.trim(),
    healthUrl: health.url,
    expectBodyContains,
    // A guessed root URL against a JSON-only API answers 404 from a healthy server (#121), so
    // grade it on "did the port bind and route" instead of a 200. Only for the guessed URL and
    // only without render assertions — an explicit health route, or a browser stack whose 404
    // page still contains <html>, must keep the strict 200 bar.
    acceptNon5xx: !health.explicit && expectBodyContains.length === 0,
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
