import { Hono } from "hono";
import { createProjectsRoute, projectsRoute } from "./projects.js";
import { createIssuesRoute, issuesRoute } from "./issues.js";
import { createWorkspacesRoute, workspacesRoute } from "./workspaces.js";
import type { Database } from "../db/index.js";

export function createRoutes(database: Database) {
  const routes = new Hono();
  routes.route("/projects", createProjectsRoute(database));
  routes.route("/issues", createIssuesRoute(database));
  routes.route("/workspaces", createWorkspacesRoute(database));
  return routes;
}

export const routes = new Hono();
routes.route("/projects", projectsRoute);
routes.route("/issues", issuesRoute);
routes.route("/workspaces", workspacesRoute);
