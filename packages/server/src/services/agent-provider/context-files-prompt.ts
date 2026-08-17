import { readFileSync } from "node:fs";

/**
 * How a provider receives its `contextFiles` — and why codex needs the prompt (#524).
 *
 * The three providers deliver context differently, which is why this is not one uniform
 * rule applied everywhere:
 * - **copilot** takes them as `--attachment <file>` args (see copilot-provider).
 * - **claude** does not read `contextFiles` at all; the agent finds the ticket-context
 *   file in its worktree on its own.
 * - **codex** has NO other channel. Appending the file CONTENTS to the prompt is the only
 *   way a codex agent ever sees them.
 *
 * That last point is what made the host/remote split a real bug rather than a cosmetic
 * one. `agent.service.ts` applied this for codex; `agent-remote.service.ts` sent the raw
 * prompt — so a codex builder dispatched to a fleet worker ran with NO ticket context at
 * all, silently, and looked like a model that had simply ignored its brief.
 *
 * Reading happens BOARD-SIDE on purpose. The files live in the board's worktree
 * (`writeWorktreeTicketContext`), and the remote worker has its own checkout, so shipping
 * paths would give the worker names it cannot resolve. Shipping the CONTENT inside the
 * prompt is what actually crosses the wire.
 */
export function appendContextFilesToPrompt(prompt: string, contextFiles: string[] | undefined): string {
  if (!contextFiles?.length) return prompt;

  const sections: string[] = [];
  for (const file of contextFiles) {
    try {
      const content = readFileSync(file, "utf-8").trim();
      if (content) {
        sections.push(`### ${file}\n\n${content}`);
      }
    } catch (err) {
      // Non-fatal by design: a missing context file degrades the prompt, it does not
      // fail the launch.
      console.warn(`[agent] failed to read context file for prompt injection: file=${file}`, err);
    }
  }

  if (sections.length === 0) return prompt;
  return `${prompt}\n\n[Attached context files]\n\n${sections.join("\n\n---\n\n")}`;
}

/**
 * The prompt a provider should actually receive. Host and remote both call this, so the
 * codex rule cannot apply on one path and not the other again.
 */
export function resolveEffectivePrompt(
  prompt: string,
  provider: string | undefined,
  contextFiles: string[] | undefined,
): string {
  return provider === "codex" ? appendContextFilesToPrompt(prompt, contextFiles) : prompt;
}
