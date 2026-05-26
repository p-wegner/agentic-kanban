import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PLAN_BEGIN_MARKER, PLAN_END_MARKER } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MCP_SERVER_PATH = resolve(__dirname, "../../../../mcp-server/src/index.ts");
const TSX_LOADER = resolve(__dirname, "../../../node_modules/tsx/dist/loader.mjs");
const TSX_URL = pathToFileURL(TSX_LOADER).href;

let claudeMcpConfigPath: string | null = null;

// --- Copilot constants ---

export const COPILOT_PLAN_PROMPT_PREFIX = [
  "IMPORTANT: This is a PLAN-ONLY session. Do NOT implement, write, edit, or modify any files.",
  "Do NOT run commands that make changes (git, npm, pnpm, yarn, pip, etc.). Only read and explore the codebase,",
  "analyze the issue, and produce a detailed implementation plan.",
  "",
  "At the very END of your response, output the complete plan as Markdown wrapped EXACTLY between",
  "these two marker lines, each on its own line with nothing else on the line:",
  PLAN_BEGIN_MARKER,
  "<your full markdown implementation plan here>",
  PLAN_END_MARKER,
  "Then stop.",
].join("\n");

export const COPILOT_PLAN_DENIED_TOOLS = [
  "write",
  "shell(git add)",
  "shell(git commit)",
  "shell(git reset)",
  "shell(git checkout)",
  "shell(git clean)",
  "shell(git push)",
  "shell(npm install)",
  "shell(pnpm install)",
  "shell(yarn install)",
  "shell(pip install)",
  "shell(rm)",
  "shell(del)",
  "shell(Remove-Item)",
];

export const COPILOT_DEFAULT_ALLOWED_TOOLS = [
  "read",
  "write",
  "search",
  "shell",
  "agentic-kanban",
];

export const COPILOT_SESSION_ID_TYPES = new Set([
  "session.start",
  "session.started",
  "session.created",
  "session_start",
  "session_started",
  "session_created",
  "result",
]);

// --- MCP config ---

export function getMcpConfigPath(): string {
  if (claudeMcpConfigPath && existsSync(claudeMcpConfigPath)) return claudeMcpConfigPath;
  const config = {
    mcpServers: {
      "agentic-kanban": {
        command: "node",
        args: ["--import", TSX_URL, MCP_SERVER_PATH],
      },
    },
  };
  const path = resolve(tmpdir(), "agentic-kanban-mcp-config.json");
  writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
  claudeMcpConfigPath = path;
  console.log(`[agent] Claude MCP config written to ${path}`);
  return path;
}

// --- Environment building ---

const PROFILE_OWNED_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "API_TIMEOUT_MS",
];

export function buildSpawnEnv(claudeProfile?: string): Record<string, string> {
  const spawnEnv: Record<string, string> = { ...process.env as Record<string, string> };

  for (const key of PROFILE_OWNED_ENV_VARS) {
    delete spawnEnv[key];
  }

  if (!claudeProfile) return spawnEnv;

  const settingsPath = join(homedir(), ".claude", `settings_${claudeProfile}.json`);
  if (!existsSync(settingsPath)) return spawnEnv;

  try {
    const profileSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (profileSettings.env && typeof profileSettings.env === "object") {
      const profileEnv = profileSettings.env as Record<string, string>;
      if (profileEnv.ANTHROPIC_AUTH_TOKEN && !profileEnv.ANTHROPIC_API_KEY) {
        delete spawnEnv.ANTHROPIC_API_KEY;
      }
      Object.assign(spawnEnv, profileEnv);
    }
  } catch (err) {
    console.warn(`[agent] Failed to read profile env from ${settingsPath}: ${err}`);
  }

  return spawnEnv;
}

// --- Utility functions ---

export function splitArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote: string | null = null;
  for (const ch of input) {
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === " " || ch === "\t") {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}

export function mapCopilotProfile(profileName: string): { flag: "--model" | "--agent"; value: string } | undefined {
  const agentPrefix = "agent:";
  const modelPrefix = "model:";
  if (profileName === "default") {
    return undefined;
  }
  if (profileName.startsWith(agentPrefix)) {
    return { flag: "--agent", value: profileName.slice(agentPrefix.length) };
  }
  if (profileName.startsWith(modelPrefix)) {
    return { flag: "--model", value: profileName.slice(modelPrefix.length) };
  }
  return { flag: "--model", value: profileName };
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function extractCopilotAssistantText(obj: Record<string, unknown>): string | undefined {
  const data = objectValue(obj.data);
  const payload = Object.keys(data).length > 0 ? data : obj;

  const direct = stringValue(payload.text ?? payload.message ?? payload.response ?? payload.result);
  if (direct) return direct;

  const item = payload.item as Record<string, unknown> | undefined;
  const itemText = stringValue(item?.text ?? item?.message);
  if (itemText) return itemText;

  const content = payload.content ?? item?.content;
  if (typeof content === "string" && content.length > 0) return content;
  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object") {
        const text = stringValue((block as Record<string, unknown>).text);
        if (text) textParts.push(text);
      }
    }
    if (textParts.length > 0) return textParts.join("\n");
  }

  return undefined;
}

// --- Windows resolvers ---

export function resolveCodexDirect(command: string): string | undefined {
  if (process.platform !== "win32") return undefined;

  const candidates: string[] = [];
  const base = basename(command).toLowerCase();
  if (base === "codex" || base === "codex.cmd" || base === "codex.ps1") {
    if (command.includes("\\") || command.includes("/")) {
      candidates.push(command);
    } else {
      const extensions = ["", ".cmd", ".ps1"];
      for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
        for (const ext of extensions) {
          candidates.push(join(dir, `codex${ext}`));
        }
      }
    }
  }

  for (const candidate of candidates) {
    const entry = join(dirname(candidate), "node_modules", "@openai", "codex", "bin", "codex.js");
    if (existsSync(entry)) return entry;
  }
  return undefined;
}

export function resolveCopilotNpmLoader(command: string): string | undefined {
  if (process.platform !== "win32") return undefined;

  const candidates: string[] = [];
  const base = basename(command).toLowerCase();
  if (base === "copilot" || base === "copilot.cmd" || base === "copilot.ps1") {
    if (command.includes("\\") || command.includes("/")) {
      candidates.push(command);
    } else {
      const extensions = ["", ".cmd", ".ps1"];
      for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
        for (const ext of extensions) {
          candidates.push(join(dir, `copilot${ext}`));
        }
      }
    }
  }

  for (const candidate of candidates) {
    const loader = join(dirname(candidate), "node_modules", "@github", "copilot", "npm-loader.js");
    if (existsSync(loader)) return loader;
  }
  return undefined;
}
