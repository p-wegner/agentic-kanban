import { Hono } from "hono";
import { db } from "../../db/index.js";
import type { Database } from "../../db/index.js";
import { createCrudRoutes } from "./crud.js";
import { createScriptRoutes } from "./scripts.js";
import { createStatusRoutes } from "./statuses.js";
import { createGitRoutes } from "./git.js";
import { createWorktreeRoutes } from "./worktrees.js";
import { createBoardRoutes } from "./board.js";

export function createProjectsRoute(database: Database = db) {
  const router = new Hono();
  router.route("/", createCrudRoutes(database));
  router.route("/", createScriptRoutes(database));
  router.route("/", createBoardRoutes(database));
  router.route("/", createStatusRoutes(database));
  router.route("/", createGitRoutes(database));
  router.route("/", createWorktreeRoutes(database));
  return router;
}

export const projectsRoute = createProjectsRoute();
