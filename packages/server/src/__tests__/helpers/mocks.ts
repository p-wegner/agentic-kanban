import { vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import type { SessionManager } from "../../services/session.manager.js";

/**
 * Creates a mock ChildProcess with event-listener tracking.
 * Useful for testing agent.service and related code that spawns subprocesses.
 */
export function createMockProc(overrides: Partial<ChildProcess> = {}): ChildProcess {
  const listeners: Record<string, Function[]> = {};
  return {
    pid: 12345,
    stdin: {
      end: vi.fn(),
      write: vi.fn(() => true),
      destroyed: false,
    } as any,
    stdout: {
      on: vi.fn((event: string, cb: Function) => {
        listeners[`stdout_${event}`] = listeners[`stdout_${event}`] || [];
        listeners[`stdout_${event}`].push(cb);
      }),
    } as any,
    stderr: {
      on: vi.fn((event: string, cb: Function) => {
        listeners[`stderr_${event}`] = listeners[`stderr_${event}`] || [];
        listeners[`stderr_${event}`].push(cb);
      }),
    } as any,
    on: vi.fn((event: string, cb: Function) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(cb);
    }),
    kill: vi.fn(),
    killed: false,
    unref: vi.fn(),
    ...overrides,
  } as any;
}

/**
 * Creates a minimal mock SessionManager for use in route/app tests.
 */
export function createMockSessionManager(): SessionManager {
  return {
    startSession: vi.fn(async () => "mock-session-id"),
    stopSession: vi.fn(async () => true),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    wsRoute: vi.fn(() => () => {}),
  } as unknown as SessionManager;
}
