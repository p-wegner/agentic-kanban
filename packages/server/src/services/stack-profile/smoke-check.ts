// Run/smoke verification harness derived from the stack profile (#791; #911 split).
//
// Project-agnostic "does it boot and respond/render" check, derived entirely from the
// profile. Re-exported byte-identically through ../stack-profile.service.ts.

import type { StackProfile, SmokeCheck } from "@agentic-kanban/shared";
import type { DevServerPlan } from "../dev-server.service.js";

/**
 * Resolve the health URL to poll, from an explicit URL or a known dev port.
 *
 * `explicit` distinguishes "the user named a real health route" from "we guessed the root URL
 * off the dev port" — only the latter may be graded leniently (#121).
 */
function resolveHealthUrl(
  profile: StackProfile,
  plan?: DevServerPlan | null,
): { url: string; explicit: boolean } | null {
  // #657: the operator override comes FIRST, because it is the one source that knows a port
  // the static profile cannot. `resolveDevServerPlan` is the single ladder that already
  // resolves `health_url_<projectId>` over the profile over this app's worktree-port
  // convention — reading its answer here is what stops the smoke gate from being a second,
  // narrower precedence ladder that disagrees with the dev-server one.
  //
  // A plan-derived URL counts as `explicit` when the plan did not merely guess it off a port:
  // both a pref and a profile health route are routes a human named, while the worktree
  // convention is arithmetic and is graded leniently for the same reason a guessed port is.
  if (plan?.healthUrl?.trim()) {
    return { url: plan.healthUrl.trim(), explicit: plan.source.healthUrl !== "worktree-port" };
  }
  if (profile.devHealthUrl && profile.devHealthUrl.trim())
    return { url: profile.devHealthUrl.trim(), explicit: true };
  if (profile.devPort && profile.devPort > 0)
    return { url: `http://127.0.0.1:${profile.devPort}`, explicit: false };
  return null;
}

/**
 * JVM/Gradle (and Maven) boot in a FRESH worktree is cold — daemon start + full compile +
 * framework boot (Ktor/Spring) — and reliably exceeds the generic 60s smoke window (#198),
 * failing the merge gate on a boot path that a retry then passes purely because the retry
 * warmed the build. Hardcoded per-stack (a physical toolchain property, not a per-project
 * tuning knob) rather than a preference.
 */
const JVM_SMOKE_TIMEOUT_SECONDS = 240;

/** Per-stack override of the smoke boot-poll budget, or `undefined` for the generic default. */
function smokeTimeoutSecondsFor(profile: StackProfile): number | undefined {
  const pm = (profile.packageManager ?? "").toLowerCase();
  return pm === "gradle" || pm === "maven" ? JVM_SMOKE_TIMEOUT_SECONDS : undefined;
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
export function buildSmokeCheck(profile: StackProfile | null, plan?: DevServerPlan | null): SmokeCheck | null {
  if (!profile || !profile.isWeb) return null;
  // The dev command follows the same rule as the health URL: an operator who told the board
  // how to boot this project should not have to tell it twice (#657).
  const devCommand = (plan?.command?.trim() || profile.devCommand?.trim()) ?? "";
  if (!devCommand) return null;
  const health = resolveHealthUrl(profile, plan);
  if (!health) return null;

  // Render assertion: for a browser UI the served document contains an <html>/<body> shell.
  // Asserting on these universal tokens (not app-specific copy) keeps the check generic across
  // any web toy-project. A non-browser HTTP service still passes on the 200 with no body needle.
  const expectBodyContains = isLikelyBrowserStack(profile) ? ["<html", "<body"] : [];

  return {
    devCommand,
    healthUrl: health.url,
    expectBodyContains,
    // A guessed root URL against a JSON-only API answers 404 from a healthy server (#121), so
    // grade it on "did the port bind and route" instead of a 200. Only for the guessed URL and
    // only without render assertions — an explicit health route, or a browser stack whose 404
    // page still contains <html>, must keep the strict 200 bar.
    acceptNon5xx: !health.explicit && expectBodyContains.length === 0,
    timeoutSeconds: smokeTimeoutSecondsFor(profile),
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
