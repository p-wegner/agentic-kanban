/**
 * The ONE wall-clock budget for a `verify_script` run, shared by the two mechanisms that run it.
 *
 * base-branch-health's own doc comment states its purpose exactly: it runs "the SAME
 * `verify_script` the pre-merge gate uses, so a red base and a red branch gate are directly
 * comparable". They were not comparable. #674 measured the script (974s of tests before the
 * clone install) and raised the BASE probe to 45 minutes, while the branch gate kept #192's
 * 20 — so the same script got budgets differing by 2.25×, and the asymmetry pointed the wrong
 * way: the base could answer "green" after 30 minutes while every branch gate timed out at 20
 * and charged the timeout to the branch.
 *
 * Measured on this repo: a full `pnpm test:mine` is ~33 minutes on 16 CPU / 30 GB. A budget
 * under that is not a safety limit, it is a guaranteed timeout — the #680 lesson in another
 * shape: a ceiling below the measured cost measures load, not correctness, and a gate that can
 * only time out withholds every merge board-wide.
 *
 * A real hang still never finishes, so a larger budget hides nothing. Per project, override
 * with `verify_timeout_ms_<projectId>` (bounded 30s … 3h by the gate).
 */
export const VERIFY_SCRIPT_TIMEOUT_MS = 45 * 60 * 1000;
