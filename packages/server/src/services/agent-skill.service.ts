import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { writeAgentSkillFile, isSkillInstalledLocally } from "@agentic-kanban/shared/lib/agent-skill-files";
import { invokeClaudePrompt } from "./claude-cli.service.js";
import {
  listAgentSkills,
  getAgentSkillById,
  findSkillByName,
  createAgentSkill,
  updateAgentSkill,
  deleteAgentSkill,
  getActiveProjectRepoPath,
} from "../repositories/agent-skill.repository.js";

export class AgentSkillError extends Error {
  constructor(
    message: string,
    public readonly code: "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT" | "FORBIDDEN" | "INTERNAL",
  ) {
    super(message);
  }
}

const INVALID_NAME_PATTERN = /[\/\\]|\.\./;

export function createAgentSkillService({ database }: { database: Database }) {
  async function listSkills(projectId?: string, globalOnly?: boolean) {
    return listAgentSkills(projectId, globalOnly ?? false, database);
  }

  async function getSkill(id: string) {
    const skill = await getAgentSkillById(id, database);
    if (!skill) throw new AgentSkillError("Skill not found", "NOT_FOUND");
    return skill;
  }

  async function createSkill(input: {
    name: string;
    description: string;
    prompt: string;
    model?: string;
    projectId?: string | null;
  }) {
    if (!input.name || !input.description || !input.prompt) {
      throw new AgentSkillError("name, description, and prompt are required", "BAD_REQUEST");
    }
    if (INVALID_NAME_PATTERN.test(input.name)) {
      throw new AgentSkillError("Skill name cannot contain '/', '\\', or '..'", "BAD_REQUEST");
    }
    const projectId = input.projectId ?? null;
    const existing = await findSkillByName(input.name, projectId, database);
    if (existing) {
      throw new AgentSkillError(`Skill '${input.name}' already exists in this scope`, "CONFLICT");
    }
    return createAgentSkill({
      name: input.name,
      description: input.description,
      prompt: input.prompt,
      model: input.model,
      projectId,
    }, database);
  }

  async function updateSkill(id: string, body: {
    name?: string;
    description?: string;
    prompt?: string;
    model?: string;
    projectId?: string | null;
  }) {
    const skill = await getAgentSkillById(id, database);
    if (!skill) throw new AgentSkillError("Skill not found", "NOT_FOUND");
    if (skill.isBuiltin) throw new AgentSkillError("Cannot modify built-in skills", "FORBIDDEN");

    const now = new Date().toISOString();
    const updates: Record<string, unknown> = { updatedAt: now };

    if (body.name !== undefined) {
      if (INVALID_NAME_PATTERN.test(body.name)) {
        throw new AgentSkillError("Skill name cannot contain '/', '\\', or '..'", "BAD_REQUEST");
      }
      const effectiveProjectId = body.projectId !== undefined ? (body.projectId ?? null) : skill.projectId;
      const dup = await findSkillByName(body.name, effectiveProjectId, database);
      if (dup && dup.id !== id) {
        throw new AgentSkillError(`Skill '${body.name}' already exists in this scope`, "CONFLICT");
      }
      updates.name = body.name;
    }
    if (body.description !== undefined) updates.description = body.description;
    if (body.prompt !== undefined) updates.prompt = body.prompt;
    if (body.model !== undefined) updates.model = body.model || null;
    if (body.projectId !== undefined) updates.projectId = body.projectId || null;

    return updateAgentSkill(id, updates, database);
  }

  async function deleteSkill(id: string) {
    const skill = await getAgentSkillById(id, database);
    if (!skill) throw new AgentSkillError("Skill not found", "NOT_FOUND");
    if (skill.isBuiltin) throw new AgentSkillError("Cannot delete built-in skills", "FORBIDDEN");
    await deleteAgentSkill(id, database);
  }

  async function enhanceSkill(name: string, description?: string, prompt?: string) {
    const aiPrompt = `You are helping create an agent skill definition for a kanban board AI coding system.
Given a skill name and optional description/prompt, return an improved version that is clear, actionable, and well-structured.
The description should be one concise sentence explaining what the skill does.
The prompt should be a detailed SKILL.md-style guide that an AI agent can follow.
Respond ONLY with valid JSON — no markdown, no explanation:
{"name": "...", "description": "...", "prompt": "..."}

Current name: ${name}
Current description: ${description?.trim() || "(none)"}
Current prompt: ${prompt?.trim() || "(none)"}`;

    const stdout = await invokeClaudePrompt(aiPrompt, { database });
    const output = stdout.trim();
    const cleaned = output.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const enhanced = JSON.parse(cleaned) as { name?: string; description?: string; prompt?: string };
    return {
      name: enhanced.name?.trim() || name,
      description: enhanced.description?.trim() ?? description ?? "",
      prompt: enhanced.prompt?.trim() ?? prompt ?? "",
    };
  }

  async function getInstallStatus(id: string) {
    const skill = await getAgentSkillById(id, database);
    if (!skill) throw new AgentSkillError("Skill not found", "NOT_FOUND");
    const repoPath = await getActiveProjectRepoPath(database);
    if (!repoPath) return { installed: false, repoPath: null };
    const installed = await isSkillInstalledLocally(repoPath, skill.name);
    return { installed, repoPath };
  }

  async function installSkill(id: string) {
    const skill = await getAgentSkillById(id, database);
    if (!skill) throw new AgentSkillError("Skill not found", "NOT_FOUND");
    const repoPath = await getActiveProjectRepoPath(database);
    if (!repoPath) throw new AgentSkillError("No active project found", "BAD_REQUEST");
    await writeAgentSkillFile(repoPath, skill);
    return { installed: true, repoPath };
  }

  return { listSkills, getSkill, createSkill, updateSkill, deleteSkill, enhanceSkill, getInstallStatus, installSkill };
}

export const agentSkillService = createAgentSkillService({ database: db });
