import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ServiceStackStatusPanel } from "./ServiceStackStatusPanel.js";

describe("ServiceStackStatusPanel", () => {
  it("renders nothing when the workspace has no service stack", () => {
    expect(renderToStaticMarkup(<ServiceStackStatusPanel serviceState={null} />)).toBe("");
    expect(renderToStaticMarkup(<ServiceStackStatusPanel serviceState={undefined} />)).toBe("");
  });

  it("renders a failed stack with the compose error message accessible", () => {
    const html = renderToStaticMarkup(
      <ServiceStackStatusPanel
        serviceState={{
          composeProjectName: "kanban-ws-42-db",
          ports: { db: 54321 },
          envFilePath: "/wt/.kanban-services.env",
          status: "error",
          error: "Cannot connect to the Docker daemon at npipe:////./pipe/docker_engine",
          updatedAt: new Date().toISOString(),
        }}
      />,
    );

    expect(html).toContain("Services failed");
    expect(html).toContain("kanban-ws-42-db");
    expect(html).toContain("Cannot connect to the Docker daemon");
  });

  it("renders a running stack with its allocated host ports", () => {
    const html = renderToStaticMarkup(
      <ServiceStackStatusPanel
        serviceState={{
          composeProjectName: "kanban-ws-7-stack",
          ports: { db: 54321, redis: 54322 },
          envFilePath: "/wt/.kanban-services.env",
          status: "up",
          updatedAt: new Date(Date.now() - 60000).toISOString(),
        }}
      />,
    );

    expect(html).toContain("Services up");
    expect(html).toContain("db:54321");
    expect(html).toContain("redis:54322");
    expect(html).not.toContain("Services failed");
  });

  it("renders a torn-down stack without an error block", () => {
    const html = renderToStaticMarkup(
      <ServiceStackStatusPanel
        serviceState={{
          composeProjectName: "kanban-ws-7-stack",
          ports: {},
          envFilePath: "/wt/.kanban-services.env",
          status: "down",
          updatedAt: new Date().toISOString(),
        }}
      />,
    );

    expect(html).toContain("Services down");
    expect(html).not.toContain("<pre");
  });
});
