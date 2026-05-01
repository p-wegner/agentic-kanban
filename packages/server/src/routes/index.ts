import { Hono } from "hono";
import { projectsRoute } from "./projects.js";
import { issuesRoute } from "./issues.js";

export const routes = new Hono();

routes.route("/projects", projectsRoute);
routes.route("/issues", issuesRoute);
