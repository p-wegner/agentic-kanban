import { describe, it, expect } from "vitest";
import { isAllowedCorsOrigin, corsOrigin } from "../lib/cors-origin.js";

describe("CORS origin allowlist", () => {
  it("allows localhost / 127.0.0.1 / ::1 on any port (dev client + worktree servers)", () => {
    for (const o of [
      "http://localhost:5173",
      "http://localhost:5174", // worktree variant
      "http://127.0.0.1:5173",
      "http://localhost:3001",
      "https://localhost:5173",
      "http://[::1]:5173",
    ]) {
      expect(isAllowedCorsOrigin(o), o).toBe(true);
      expect(corsOrigin(o), o).toBe(o); // echoes the specific origin, never "*"
    }
  });

  it("allows the Tauri desktop webview origins", () => {
    for (const o of ["tauri://localhost", "https://tauri.localhost", "http://tauri.localhost"]) {
      expect(isAllowedCorsOrigin(o), o).toBe(true);
      expect(corsOrigin(o), o).toBe(o);
    }
  });

  it("rejects arbitrary external origins (the confused-deputy attack)", () => {
    for (const o of [
      "https://evil.com",
      "http://evil.com",
      "https://localhost.evil.com", // suffix trick
      "https://notlocalhost",
      "http://169.254.169.254", // link-local metadata
      "http://10.0.0.5:3001", // LAN host
      "https://example.com:3001",
    ]) {
      expect(isAllowedCorsOrigin(o), o).toBe(false);
      expect(corsOrigin(o), o).toBeNull(); // no Access-Control-Allow-Origin → browser blocks
    }
  });

  it("rejects empty / missing / malformed origins", () => {
    for (const o of ["", undefined, null, "not a url", "javascript:alert(1)"]) {
      expect(isAllowedCorsOrigin(o as string)).toBe(false);
    }
    expect(corsOrigin("")).toBeNull();
  });
});
