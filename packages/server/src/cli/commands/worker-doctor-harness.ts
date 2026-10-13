import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DoctorCheck } from "./worker-doctor.js";
import { readOAuthCredentials } from "../../lib/oauth-quota-core.js";
import { settingsHaveHooks, type WorkerHarness } from "../../worker/worker-harness.js";
import type { LocalProfile } from "../../lib/local-profile-discovery.js";
import { narrowDeclaredProfiles } from "../../worker/worker-profiles.js";

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
  /** #1373: flags that disagree with the state file, and whether the pairing predates modes. */
  extra: { notes?: string[]; legacy?: boolean } = {},
): DoctorCheck[] {
  const customDirs = ["claude", "codex"].flatMap((p) => (harness.dirFor(p) && harness.mode === "custom" ? [`${p}: ${harness.dirFor(p)}`] : []));
  const modeDetail: Record<WorkerHarness["mode"], string> = {
    clean: `clean - sessions run in the worker's own config under ${harness.root} (no user hooks/plugins/skills)`,
    custom: `custom - sessions run in the config folder recorded for ${harness.stateFile} (${customDirs.join("; ")})`,
    inherit:
      "inherit (dirty mode, --inherit-user-config) - sessions see this machine's own ~/.claude, hooks " +
      "and all, so results depend on the machine",
  };
  const checks: DoctorCheck[] = [
    harness.mode === "inherit"
      ? {
          name: "harness mode",
          status: "warn",
          detail: extra.legacy
            ? "inherit - this pairing predates harness modes, so this worker still uses your own ~/.claude"
            : modeDetail.inherit,
          ...(extra.legacy
            ? { remedy: `agentic-kanban-worker auth claude${harness.authFlags("claude")}, then restart with --clean to switch` }
            : {}),
        }
      : { name: "harness mode", status: "pass", detail: modeDetail[harness.mode] },
  ];
  for (const note of extra.notes ?? []) {
    checks.push({ name: "harness flags", status: "warn", detail: note });
  }
  for (const provider of providers) {
    const dir = harness.dirFor(provider);
    if (!dir) continue;
    const name = `${provider} harness dir`;
    if (!existsSync(dir)) {
      checks.push({
        name,
        status: harness.mode === "custom" ? "fail" : "warn",
        detail: `${dir} does not exist${harness.mode === "clean" ? " yet (created on the first session or login)" : ""}`,
        remedy: `agentic-kanban-worker auth ${provider}${harness.authFlags(provider)}`,
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
                remedy: `agentic-kanban-worker auth claude --token${harness.authFlags(provider)}`,
              }
            : { name: "claude credential", status: "pass", detail: `token (stored by the worker)${when}` },
        );
      } else if (existsSync(dir)) {
        const read = readOAuthCredentials(dir, nowMs);
        if (read.err === "expired" && read.refreshable) {
          checks.push({
            name: "claude credential",
            status: "pass",
            detail: `login present in ${dir} (access token expired; claude renews it with the stored refresh token)`,
          });
        } else if (read.err === "expired") {
          checks.push({
            name: "claude credential",
            status: "warn",
            detail: `the login in ${dir} has expired`,
            remedy: `agentic-kanban-worker auth claude${harness.authFlags(provider)}`,
          });
        } else if (read.err) {
          checks.push({
            name: "claude credential",
            status: "unknown",
            detail: `no OAuth login in ${dir} (${read.err}); an env API key would not be visible here`,
            remedy:
              `agentic-kanban-worker auth claude${harness.authFlags(provider)}   ` +
              `(or: auth claude --token${harness.authFlags(provider)})`,
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
        remedy: `agentic-kanban-worker auth codex${harness.authFlags(provider)}`,
      });
    }
  }
  return checks;
}

/**
 * #1450: which local profiles this worker advertises. Without `--profiles` that is EVERY login on the
 * machine (14 of them on the first live connect), so placement can run sessions on any a roster names.
 * WARN then, listing them; with a restriction, PASS naming exactly the attested set.
 */
export function checkAttestedProfiles(discovered: readonly LocalProfile[], declared: string[] | undefined): DoctorCheck {
  const name = "attested profiles";
  const attested = narrowDeclaredProfiles(discovered, declared, () => {});
  const list = attested.map((p) => `${p.provider}:${p.name}`).join(", ") || "none";
  if (declared === undefined) {
    return {
      name,
      status: attested.length > 1 ? "warn" : "pass",
      detail: `no --profiles: all ${attested.length} local profile(s) are attested - ${list}`,
      ...(attested.length > 1 ? { remedy: "Restrict what this machine offers: start with --providers <csv> --profiles <names> (the Connect view renders both)." } : {}),
    };
  }
  const missing = declared.map((d) => d.trim()).filter((d) => d && d.toLowerCase() !== "none" && !discovered.some((p) => p.name === d));
  return {
    name,
    status: missing.length > 0 ? "warn" : "pass",
    detail: `--profiles restricts this worker to ${attested.length} profile(s): ${list}` + (missing.length > 0 ? `; no local login named ${missing.join(", ")}` : ""),
    ...(missing.length > 0 ? { remedy: `Log in to ${missing.join(", ")} or drop it from --profiles.` } : {}),
  };
}
