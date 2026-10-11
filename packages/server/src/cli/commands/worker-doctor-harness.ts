import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DoctorCheck } from "./worker-doctor.js";
import { readOAuthCredentials } from "../../lib/oauth-quota-core.js";
import { settingsHaveHooks, type WorkerHarness } from "../../worker/worker-harness.js";

/**
 * The worker's own provider config (#1367), as the doctor sees it: which mode is active, and
 * for each provider whether the dir exists, a credential is present/expired, and (claude)
 * the settings.json carries no hooks. Lives in its own module because worker-doctor.ts sits at
 * the god-module gate's declaration ceiling (#889). Db-free.
 */
export function checkHarness(
  harness: WorkerHarness,
  providers: string[],
  nowMs: number = Date.now(),
): DoctorCheck[] {
  const modeDetail: Record<WorkerHarness["mode"], string> = {
    clean: `clean - sessions run in the worker's own config under ${harness.root} (no user hooks/plugins/skills)`,
    custom: "custom - sessions run in the config folder you passed (--config-dir / --codex-home)",
    inherit:
      "inherit (dirty mode, --inherit-user-config) - sessions see this machine's own ~/.claude, hooks " +
      "and all, so results depend on the machine",
  };
  const checks: DoctorCheck[] = [
    harness.mode === "inherit"
      ? { name: "harness mode", status: "warn", detail: modeDetail.inherit }
      : { name: "harness mode", status: "pass", detail: modeDetail[harness.mode] },
  ];
  for (const provider of providers) {
    const dir = harness.dirFor(provider);
    if (!dir) continue;
    const name = `${provider} harness dir`;
    if (!existsSync(dir)) {
      checks.push({
        name,
        status: harness.mode === "custom" ? "fail" : "warn",
        detail: `${dir} does not exist${harness.mode === "clean" ? " yet (created on the first session or login)" : ""}`,
        remedy: `agentic-kanban-worker auth ${provider}`,
      });
    } else {
      checks.push({ name, status: "pass", detail: dir });
    }
    if (provider === "claude") {
      const token = harness.tokenStatus(provider, nowMs);
      if (token.stored) {
        const when = token.expiresAtMs ? ` (expires about ${new Date(token.expiresAtMs).toISOString().slice(0, 10)})` : "";
        checks.push(
          token.expired
            ? {
                name: "claude credential",
                status: "warn",
                detail: `the token stored by the worker has expired${when}`,
                remedy: "agentic-kanban-worker auth claude --token",
              }
            : { name: "claude credential", status: "pass", detail: `token (stored by the worker)${when}` },
        );
      } else if (existsSync(dir)) {
        const read = readOAuthCredentials(dir, nowMs);
        if (read.err === "expired") {
          checks.push({
            name: "claude credential",
            status: "warn",
            detail: `the login in ${dir} has expired`,
            remedy: "agentic-kanban-worker auth claude",
          });
        } else if (read.err) {
          checks.push({
            name: "claude credential",
            status: "unknown",
            detail: `no OAuth login in ${dir} (${read.err}); an env API key would not be visible here`,
            remedy: "agentic-kanban-worker auth claude   (or: auth claude --token)",
          });
        } else {
          checks.push({ name: "claude credential", status: "pass", detail: `login present in ${dir}` });
        }
      }
      const settings = join(dir, "settings.json");
      if (settingsHaveHooks(settings)) {
        checks.push({
          name: "claude harness hooks",
          status: harness.mode === "clean" ? "fail" : "warn",
          detail: `${settings} defines hooks - they run in every worker session`,
          remedy: harness.mode === "clean" ? `Remove the "hooks" from ${settings}` : "Use a config folder without hooks for the worker",
        });
      }
    } else if (provider === "codex" && existsSync(dir) && !existsSync(join(dir, "auth.json"))) {
      checks.push({
        name: "codex credential",
        status: "unknown",
        detail: `no auth.json in ${dir}`,
        remedy: "agentic-kanban-worker auth codex",
      });
    }
  }
  return checks;
}
