import { parseAgentProviderStreamLine, parseAgentProviderStreamLineObserved } from "@agentic-kanban/shared/lib/agent-stream-parser";
import type { AgentLaunchConfig, AgentProvider, FileSystem, ParsedStreamEvent, ProviderLaunchOptions } from "./types.js";
import { nodeFileSystem, spliceAgentArgs, resolveMockLaunch, commandCarriesArgs } from "./helpers.js";

/**
 * Herdr provider adapter (#1144 launch config, #1145 spawn/stream/exit). Herdr is a
 * terminal multiplexer for coding agents — it does not itself run a model, it drives an
 * agent CLI (claude/codex/…) inside a managed pane and exposes that pane's output via
 * its own CLI. The launch shape mirrors Pi's: a `--mode json` (structured) invocation
 * reading the prompt via `-p`.
 *
 * Spawn, output streaming, persistence and exit classification are NOT reimplemented
 * here — `agent.service.ts` spawns whatever `buildLaunchConfig` returns exactly like
 * every other provider (plain `child_process.spawn`, generic stdout/stderr wiring,
 * exit code -> `classifySessionExit`), and `session-manager/broadcast.ts` is the one
 * seam that turns stdout lines into persisted/broadcast session messages for every
 * provider alike. The only herdr-specific piece is PARSING those lines: since herdr
 * relays the driven agent's own stream verbatim rather than emitting a format of its
 * own, `agent-stream-parser.ts`'s `case "herdr"` reuses Claude's parser (see its
 * comment) instead of Pi's — Claude is the default driven agent and what the
 * mock-agent test harness emits regardless of which provider spawned it.
 *
 * Availability is machine-dependent (requires the `herdr` binary on PATH plus a
 * reachable server — see `herdr-availability.ts`), so this provider is registered
 * unconditionally but only ever OFFERED to a user when `detectHerdrAvailability()`
 * reports available (Settings UI gating + agent-profile-health).
 */
export class HerdrProvider implements AgentProvider {
  readonly name = "herdr";
  readonly profilePrefKey = "herdr_profile";
  private readonly fs: FileSystem;

  constructor(fs: FileSystem = nodeFileSystem) {
    this.fs = fs;
  }

  buildLaunchConfig(options: ProviderLaunchOptions): AgentLaunchConfig {
    const { agentArgs, agentCommand, keepAlive, providerSessionId, prompt, systemInstructions } = options;
    const isWindows = process.platform === "win32";
    const { isMockAgent, command: resolvedCommand, mockArgs } = resolveMockLaunch(
      { agentCommand, providerSessionId, keepAlive },
      "herdr",
    );
    const command = resolvedCommand;
    const useShell = isWindows || commandCarriesArgs(command);

    const args: string[] = [];
    let suppressStdinPrompt = false;

    if (isMockAgent) {
      args.push(...mockArgs);
    } else {
      args.push("--mode", "json");

      if (providerSessionId) {
        args.push("--session", providerSessionId);
      }

      args.push(...spliceAgentArgs(this.name, agentArgs));

      const promptArg = systemInstructions ? `${systemInstructions}\n\n${prompt ?? ""}` : (prompt ?? "");
      args.push("-p", promptArg);
      suppressStdinPrompt = true;
    }

    return {
      command,
      args,
      useShell,
      isMockAgent,
      env: { ...process.env as Record<string, string> },
      keepStdinOpen: false,
      suppressStdinPrompt,
    };
  }

  parseStreamEvent(line: string): ParsedStreamEvent | undefined {
    return parseAgentProviderStreamLine("herdr", line);
  }

  parseStreamEventObserved(line: string): ParsedStreamEvent | undefined {
    return parseAgentProviderStreamLineObserved("herdr", line);
  }
}
