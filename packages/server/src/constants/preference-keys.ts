export const PREF_AGENT_COMMAND = "agent_command";
export const PREF_AGENT_ARGS = "agent_args";
export const PREF_SKIP_PERMISSIONS = "skip_permissions";
export const PREF_CLAUDE_PROFILE = "claude_profile";
export const PREF_CODEX_PROFILE = "codex_profile";
// Pi profiles select an isolated PI_CODING_AGENT_DIR per profile. The exact LLM
// provider/key mapping inside that directory is owned by Pi's config.
export const PREF_PI_PROFILE = "pi_profile";
export const PREF_CODEX_LICENSE_RING = "codex_license_ring";
export const PREF_CODEX_LICENSE_ROTATION = "codex_license_rotation";
export const PREF_CLAUDE_SUBSCRIPTION_RING = "claude_subscription_ring";
export const PREF_CLAUDE_SUBSCRIPTION_ROTATION = "claude_subscription_rotation";
export const PREF_COPILOT_PROFILE = "copilot_profile";
export const PREF_PROVIDER = "provider";
export const PREF_DEFAULT_MODEL = "default_model";
export const PREF_MOCK_AGENT_PROFILE = "mock_agent_profile";
export const PREF_MOCK_AGENT_DELAY_MS = "mock_agent_delay_ms";
export const PREF_RESUME_WITH_NEW_MODEL = "resume_with_new_model";
export const PREF_PERMISSION_PROMPT_TOOL = "permission_prompt_tool";
export const PREF_LEARNING_STEP_BEFORE_MERGE = "learning_step_before_merge";
export const PREF_AUTO_START_FOLLOWUP = "auto_start_followup";
export const PREF_PROJECTS_BASE_PATH = "projects_base_path";
export const PREF_BUTLER_AUTO_ANSWER = "butler_auto_answer";
export const PREF_BUTLER_AUTO_ANSWER_MIN_CONFIDENCE = "butler_auto_answer_min_confidence";
export const PREF_BUILDER_GUARDRAILS = "builder_guardrails";
export const PREF_MERGE_STRATEGY = "merge_strategy";
export const PREF_RECONCILER_ANCESTOR_BRANCH_ENABLED = "reconciler_ancestor_branch_enabled";
export const PREF_RECONCILER_STRANDED_REVIEW_ENABLED = "reconciler_stranded_review_enabled";
export const PREF_RECONCILER_ZOMBIE_FIX_ENABLED = "reconciler_zombie_fix_enabled";
export const PREF_DONE_UNMERGED_SCANNER_ENABLED = "done_unmerged_scanner_enabled";
export const DEFAULT_BUILDER_GUARDRAILS =
  "The board owns all visual verification and screenshots. Do NOT run npx playwright install or install any browser/runtime/global package. " +
  "Treat any mention of screenshots / visual verification in the ticket as context, not a task. " +
  "Run tests FROM YOUR WORKTREE ROOT with pnpm test:mine -- --changed HEAD (or pnpm exec vitest from the package dir). Never run tests from the main checkout - your new test files only exist on your branch. If vitest cannot resolve imports, report it and continue; do NOT run pnpm install. " +
  "When the implementation logic is complete and self-reviewed, COMMIT and finish -- do not loop on environment setup.";
