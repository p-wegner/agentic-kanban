// @gate:always-run — recursively scans package src trees; imports nothing it checks.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * ProviderName → ProviderId is mapped in exactly ONE place (#503).
 *
 * `toExecutorProvider` (agent-settings.service.ts) already had ~25 adopters when this
 * guard was written, so the abstraction was never the problem — the two stragglers were.
 * One of them was wrong:
 *
 *     provider === "codex" ? "codex" : "claude-code"   // followup-workspace.service.ts
 *
 * `provider` there is a ProviderName from `resolveAgentSettings`, so that ternary sent
 * BOTH copilot and pi follow-up workspaces to Claude. A follow-up workspace launching on
 * the wrong agent is close to invisible — it runs, it produces output, it just isn't the
 * provider the project selected — which is exactly why this needs a gate rather than care.
 *
 * The registry's own comment claims to have replaced these ladders. It had not; this is
 * what makes that claim true and keeps it true.
 *
 * Scope note: only the FORWARD direction is guarded. The inverse (`"claude-code"` → a
 * canonical name) is already consolidated as `narrowProviderName` (server) and
 * `narrowPolicyProvider` (shared), and `getProvider` deliberately THROWS on an unknown
 * provider where the narrowers default to "claude" — collapsing those would turn a typo'd
 * provider into a silent Claude launch, so they are intentionally left alone.
 */
const packagesRoot = path.join(import.meta.dirname!, "..", "..", "..");
const SCAN_ROOTS = ["server/src", "shared/src", "mcp-server/src", "client/src"];

/** The one sanctioned home of the forward map. */
const ALLOWED = new Set([path.join("server", "src", "services", "agent-settings.service.ts")]);

/**
 * A ternary that PRODUCES the executor id `"claude-code"` — the forward map, and the only
 * shape this guard owns.
 *
 * Anchoring on the produced literal rather than on the compared provider name is
 * deliberate. The first version of this guard matched "compares a ProviderName and yields
 * a string literal", which flagged 17 sites that are not forward maps at all: provider-name
 * NARROWING ladders (`x === "codex" ? "codex" : … : "claude"`, which map name→name) and even
 * a `=== "codex" ? "--profile"` CLI-flag choice. A guard with a baseline of false positives
 * trains people to add allowlist entries instead of catching drift.
 *
 * `(?<!\?)\?(?![?.])` excludes `??` and `?.`, so a plain default (`provider ?? "claude-code"`)
 * and optional chaining are not mistaken for a mapping. Requiring the match to stay on one
 * statement (`[^;\n]*`) keeps the sanctioned INVERSE (`value === "claude-code" ? "claude" : value`)
 * out — there the executor id is the INPUT, never the produced branch.
 */
const HAND_ROLLED = /(?<!\?)\?(?![?.])[^;\n]*"claude-code"/g;

function sourceFiles(rel: string): string[] {
  const abs = path.join(packagesRoot, rel);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!["__tests__", "node_modules", "dist"].includes(e.name)) walk(full);
        continue;
      }
      if (/\.tsx?$/.test(e.name) && !e.name.includes(".test.")) out.push(full);
    }
  };
  walk(abs);
  return out;
}

/**
 * Blank out comments, preserving offsets so reported line numbers stay true.
 *
 * Without this the guard flags its own documentation: the fix for #503 left a comment
 * QUOTING the ternary it removed, and the scan dutifully reported it. A guard that
 * punishes you for describing the defect it caught is a guard people delete.
 *
 * Deliberately naive (it does not track string literals), so a `"…//…"` containing
 * `"claude-code"` after the slashes would be missed. That is a false NEGATIVE in a case
 * that does not occur here, which is the safe direction for a heuristic net.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

function offenders(): string[] {
  const found: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of sourceFiles(root)) {
      const rel = path.relative(packagesRoot, file);
      if (ALLOWED.has(rel)) continue;
      const text = stripComments(fs.readFileSync(file, "utf8"));
      for (const m of text.matchAll(HAND_ROLLED)) {
        const line = text.slice(0, m.index).split("\n").length;
        found.push(`${rel.replace(/\\/g, "/")}:${line}  ${m[0].trim()}`);
      }
    }
  }
  return found;
}

describe("ProviderName → ProviderId is mapped in one place (#503)", () => {
  it("no hand-rolled provider→executor ternary outside agent-settings.service.ts", () => {
    expect(
      offenders(),
      "Use toExecutorProvider(provider) from services/agent-settings.service.ts:\n" +
        offenders().join("\n"),
    ).toEqual([]);
  });

  it("the pattern actually matches a hand-rolled ladder, so the guard cannot pass vacuously", () => {
    // The exact line this ticket removed from followup-workspace.service.ts.
    const planted = `provider: provider === "codex" ? "codex" : "claude-code",`;
    expect(planted.match(HAND_ROLLED)).not.toBeNull();
    // ...and the correct-but-duplicated copy from claude-cli.service.ts.
    expect(`provider: providerName === "claude" ? "claude-code" : providerName,`.match(HAND_ROLLED))
      .not.toBeNull();
  });

  it("does NOT flag the sanctioned inverse mapping, which must keep its own semantics", () => {
    // registry.ts / strategy-policy.ts narrow the legacy executor id back to a name.
    expect(`const key = value === "claude-code" ? "claude" : value;`.match(HAND_ROLLED)).toBeNull();
    // A plain default is not a mapping either.
    expect(`const executor = provider ?? "claude-code";`.match(HAND_ROLLED)).toBeNull();
  });
});
