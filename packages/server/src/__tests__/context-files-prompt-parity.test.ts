// @gate:always-run — reads the two launch services off disk; imports neither.
//
// #524. `contextFiles` reach codex ONLY by having their contents appended to the prompt
// (claude ignores the field; copilot passes `--attachment`). The host path did that; the
// remote path sent the raw prompt — so a codex builder dispatched to a fleet worker ran
// with NO ticket context, silently, and looked like a model ignoring its brief.
//
// The unit test below covers the rule. The SOURCE SCAN is the part that actually prevents
// the regression: the bug was not a wrong rule, it was one call site not calling it, and
// no behavioural test of the host path can notice that the remote path is missing.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolveEffectivePrompt, appendContextFilesToPrompt } from "../services/agent-provider/context-files-prompt.js";

const SERVICES = join(import.meta.dirname!, "..", "services");

describe("resolveEffectivePrompt (#524)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctxfiles-"));
  const file = join(dir, "CLAUDE.local.md");
  writeFileSync(file, "TICKET BODY HERE", "utf-8");

  it("appends file CONTENT for codex — the content is what crosses the wire", () => {
    // Deliberately asserting on content, not the path: a remote worker has its own
    // checkout, so shipping a board-side path would name a file it cannot resolve.
    const out = resolveEffectivePrompt("do the thing", "codex", [file]);
    expect(out).toContain("do the thing");
    expect(out).toContain("TICKET BODY HERE");
  });

  it("leaves other providers' prompts untouched", () => {
    // claude finds the file in its worktree itself; copilot gets --attachment args.
    expect(resolveEffectivePrompt("p", "claude", [file])).toBe("p");
    expect(resolveEffectivePrompt("p", "copilot", [file])).toBe("p");
    expect(resolveEffectivePrompt("p", undefined, [file])).toBe("p");
  });

  it("is a no-op with no context files", () => {
    expect(resolveEffectivePrompt("p", "codex", undefined)).toBe("p");
    expect(resolveEffectivePrompt("p", "codex", [])).toBe("p");
  });

  it("survives an unreadable file rather than failing the launch", () => {
    const missing = join(dir, "does-not-exist.md");
    expect(appendContextFilesToPrompt("p", [missing])).toBe("p");
  });
});

describe("host and remote apply the same prompt rule (#524)", () => {
  it("neither launch service open-codes the codex check", () => {
    // The original bug in one line: `provider === "codex" ? append(...) : prompt` lived
    // in agent.service.ts and nowhere else. If it reappears inline in either file, the
    // two paths can drift again exactly as they did.
    for (const f of ["agent.service.ts", "agent-remote.service.ts"]) {
      const src = readFileSync(join(SERVICES, f), "utf-8");
      expect(src, `${f} re-implements the codex context-file rule inline`)
        .not.toMatch(/provider\s*===\s*"codex"\s*\r?\n?\s*\?\s*appendContextFilesToPrompt/);
    }
  });

  it("BOTH services route their prompt through resolveEffectivePrompt", () => {
    // The assertion that would have caught the original defect: the remote file simply
    // never mentioned the helper.
    for (const f of ["agent.service.ts", "agent-remote.service.ts"]) {
      const src = readFileSync(join(SERVICES, f), "utf-8");
      expect(src, `${f} does not call resolveEffectivePrompt — its prompt can lose context files`)
        .toContain("resolveEffectivePrompt(");
    }
  });
});
