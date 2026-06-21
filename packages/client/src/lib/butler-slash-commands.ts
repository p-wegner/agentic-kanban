// Pure slash-command parsing + cycle math for the Butler input. Extracted so the
// trailing-token regex lives in ONE place (it was written twice) and the apply
// splice math is unit-tested (off-by-one prone); the component keeps the focus/
// setState side effects.

/** Matches a trailing "/cmd" token at the end of the input (after start or whitespace). */
const SLASH_COMMAND_RE = /(?:^|\s)\/([\w:-]*)$/;

/** The trailing slash-command query (the text after "/"), or null when there is no slash token. */
export function parseSlashCommand(input: string): string | null {
  const m = SLASH_COMMAND_RE.exec(input);
  return m ? (m[1] ?? "") : null;
}

/** Commands whose name contains `query` (case-insensitive), capped at 8. */
export function filterCommands<T extends { name: string }>(commands: T[], query: string): T[] {
  return commands
    .filter((cmd) => cmd.name.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 8);
}

/**
 * Replace the trailing slash token in `input` with "/<name> ". Returns null when
 * there is no slash token to replace (caller no-ops).
 */
export function applyCommandToInput(input: string, name: string): string | null {
  const m = SLASH_COMMAND_RE.exec(input);
  if (!m) return null;
  const slashStart = m.index + m[0].length - (m[1].length + 1);
  return `${input.slice(0, slashStart)}/${name} `;
}

/** Next index in a wrap-around cycle of `length` items (forward by one). */
export function nextCycleIndex(length: number, currentIndex: number): number {
  return (currentIndex + 1 + length) % length;
}
