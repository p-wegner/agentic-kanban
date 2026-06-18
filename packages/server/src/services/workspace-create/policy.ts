/**
 * Pure workspace-creation POLICY — the build-prompt + visual-verification rules
 * lifted out of the 1700-LOC, IO-bound workspace-crud.service so they can be
 * unit-tested in milliseconds without a DB, git, or a spawned agent.
 *
 * These encode hard-won lessons (notably: a Codex builder that reads a "visually
 * verify / install playwright" instruction hangs forever on `npx playwright install`).
 * Keeping them as exported pure functions means those regressions are guarded by a
 * fast unit table, not only reachable through the full launch path.
 */

export interface BuildAgentPromptInput {
  customPrompt?: string | null;
  includeVisualProof?: boolean;
  clarifications?: string | null;
}

/** Build the agent's initial prompt from the issue + creation input. Pure. */
export function buildAgentPrompt(
  issue: { title: string; description: string | null },
  input: BuildAgentPromptInput,
  // Retained for call-site compatibility; the prompt does not depend on the id.
  _issueId?: string,
): string {
  let prompt: string;
  if (input.customPrompt) {
    prompt = input.customPrompt;
  } else {
    prompt = issue.title;
    if (issue.description) {
      prompt += `\n\n${issue.description}`;
    }
  }
  // Prepend answered preflight clarifications so the agent starts with the resolved
  // Q&A as part of its spec (the user already reconciled these ambiguities).
  if (input.clarifications?.trim()) {
    prompt = `${input.clarifications.trim()}\n\n${prompt}`;
  }
  prompt = neutralizeBuildTimeVisualVerification(prompt);
  if (input.includeVisualProof) {
    prompt += `\n\n## Board-Owned Visual Verification\n\nThis workspace is marked for visual proof, but visual verification is a board step, not a builder step. Do not run Playwright, install browsers, take screenshots, or attach visual artifacts during implementation. Finish the code change, run the relevant non-visual tests, commit, and let the board handle visual verification according to \`visual_verification_mode\` and \`after_merge_verify_agent\`.`;
  }
  // Claude Code treats prompts that start with `/` as slash-command invocations
  // (e.g. ticket title "/merge endpoint ..." → "Unknown command: /merge", agent exits in 3s).
  // Prefix a space to neutralize without altering meaning.
  if (prompt.startsWith("/")) {
    prompt = " " + prompt;
  }
  return prompt;
}

/** Strip build-time visual-verification instructions from a prompt. Pure. */
export function neutralizeBuildTimeVisualVerification(prompt: string): string {
  const lines = prompt.split(/\r?\n/);
  const kept = lines.filter((line) => !isBuildTimeVisualVerificationInstruction(line));
  if (kept.length === lines.length) return prompt;
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Whether a single prompt line is a build-time visual-verification / browser-install
 * instruction that must NOT reach a builder (the board owns visual verification).
 * Distinguishes genuine product requirements ("add a screenshot button") from
 * lifecycle proof demands ("attach a screenshot before finishing"). Pure.
 */
export function isBuildTimeVisualVerificationInstruction(line: string): boolean {
  const normalized = line.trim().toLowerCase();
  if (!normalized) return false;
  if (/\bnpx\s+playwright\s+install\b/.test(normalized)) return true;
  if (/\bplaywright\s+install\b/.test(normalized)) return true;
  if (/\binstall\b.*\b(browser|browsers|runtime|runtimes|global package|playwright)\b/.test(normalized)) return true;

  if (/\b(playwright-cli|run playwright|playwright directly)\b/.test(normalized)) return true;

  const lifecycleInstruction =
    /\b(after completing|after completion|before finishing|before completion|when done|before submitting|before review|before proposing review)\b/.test(normalized);
  const productRequirement =
    /\b(implement|add|create|build|support|display|render|save|upload|download|button|component|endpoint|api|user|users|customer|client|canvas|image|attachment|attachments)\b/.test(normalized);
  if (productRequirement && !lifecycleInstruction) return false;

  const proofInstruction =
    /\b(attach|provide|include|submit|upload|capture|take)\b.*\b(proof|evidence|screenshot|screenshots|visual proof)\b/.test(normalized) ||
    /\b(screenshot|screenshots|visual proof)\b.*\b(proof|evidence|showing it working|before finishing|after completing)\b/.test(normalized);
  const verificationInstruction =
    /\b(visual verification|visually verify|verify visually)\b/.test(normalized) &&
    /\b(must|should|required|run|perform|complete|do|use|before|after|verify)\b/.test(normalized);

  return (
    (lifecycleInstruction && (proofInstruction || verificationInstruction)) ||
    proofInstruction ||
    verificationInstruction
  );
}
