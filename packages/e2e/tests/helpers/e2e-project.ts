/**
 * Helper to retrieve the E2E test project created by global-setup.
 *
 * global-setup always creates a fresh dedicated project and sets it as the active project.
 * Use `getE2EProject` / `getE2EProjectId` in test `beforeAll` hooks instead of `projects[0]`
 * to ensure tests operate on the isolated E2E project, never on a real production project.
 */

import type { APIRequestContext } from "@playwright/test";
import { SERVER_URL } from "./port.js";

export interface E2EProject {
  id: string;
  name: string;
  repoPath: string;
  defaultBranch: string;
  [key: string]: unknown;
}

/**
 * Returns the full project object for the active E2E test project.
 * Throws if no active project is configured (e.g. global-setup failed).
 */
export async function getE2EProject(request: APIRequestContext): Promise<E2EProject> {
  const prefRes = await request.get(`${SERVER_URL}/api/preferences/active-project`);
  if (!prefRes.ok()) {
    throw new Error(`[getE2EProject] Could not read active-project preference: ${prefRes.status()}`);
  }
  const { projectId } = await prefRes.json();
  if (!projectId) {
    throw new Error("[getE2EProject] No active project is set — did global-setup run?");
  }

  const projectsRes = await request.get(`${SERVER_URL}/api/projects`);
  if (!projectsRes.ok()) {
    throw new Error(`[getE2EProject] Could not list projects: ${projectsRes.status()}`);
  }
  const projects: E2EProject[] = await projectsRes.json();
  const project = projects.find((p) => p.id === projectId);
  if (!project) {
    throw new Error(`[getE2EProject] Active project ${projectId} not found in projects list`);
  }
  return project;
}

/** Convenience wrapper that returns just the project ID. */
export async function getE2EProjectId(request: APIRequestContext): Promise<string> {
  const project = await getE2EProject(request);
  return project.id;
}
