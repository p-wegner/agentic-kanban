/**
 * Which skills a BUILDER agent actually uses, and how to tell it they exist.
 *
 * Background (#129): a fleet analysis of 200 builder sessions found 0/47
 * materialized skills were ever agent-invoked. Every skill sitting in a
 * worktree's `.claude/skills` pays an always-on name+description context tax on
 * EVERY turn — so a skill no builder fires is pure waste, re-billed per turn for
 * the life of the session.
 *
 * Two levers, both driven from this module:
 *   (a) the builder prompt NAMES the skills present in its worktree, so the ones
 *       that should fire actually do (`buildSkillInvocationBlock`);
 *   (b) the registration-time builtin export only writes the skills a builder
 *       can plausibly use (`BUILDER_SKILL_ALLOWLIST`), so the rest never become
 *       a tax in the first place.
 *
 * Pure string policy — no filesystem, no DB, no Node builtins. Safe to import
 * from either side of the wire.
 */

/**
 * Builtin/local skills a worktree agent (builder or reviewer) plausibly fires.
 *
 * Deliberately NOT included: `dependency-analyzer`, `ticket-enhancer`,
 * `orchestrator`, `monitor-nudge`, `code-review-thorough`. Those are board-side
 * roles (monitor, conductor, enhancement) that run from their DB prompt against
 * the main checkout — they never execute as a worktree agent, so materializing
 * them into a worktree only buys context tax.
 */
export const BUILDER_SKILL_ALLOWLIST: readonly string[] = [
  "board-navigator",
  "kanban-workflow",
  "scope-guard",
  "code-review",
];

/** Whether a skill is worth materializing into a worktree at all. */
export function isBuilderRelevantSkill(name: string): boolean {
  return BUILDER_SKILL_ALLOWLIST.includes(name);
}

/**
 * Narrow a set of skill names to the ones a worktree agent uses, preserving the
 * caller's order and dropping duplicates.
 */
export function selectBuilderSkills(names: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    if (!isBuilderRelevantSkill(name)) continue;
    if (out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

/**
 * The prompt block that turns a materialized skill from dead weight into a tool
 * the agent knows to reach for. Returns "" when there is nothing to announce —
 * an empty "Available Skills" heading would itself be tax.
 *
 * Kept deliberately short: this text is re-billed every turn, so it must earn
 * more than it costs.
 */
export function buildSkillInvocationBlock(skillNames: readonly string[]): string {
  const unique: string[] = [];
  for (const name of skillNames) {
    if (typeof name !== "string") continue;
    const trimmed = name.trim();
    if (!trimmed || unique.includes(trimmed)) continue;
    unique.push(trimmed);
  }
  if (unique.length === 0) return "";
  const list = unique.map((n) => `\`${n}\``).join(", ");
  return [
    "## Skills available in this worktree",
    "",
    list,
    "",
    `Each is a \`.claude/skills/<name>/SKILL.md\` in this worktree holding the worked-out steps for its task. Invoke one (e.g. \`/${unique[0]}\`) when its description matches what you are about to do — do not re-derive its steps by hand. Skills not listed above are not available here.`,
  ].join("\n");
}
