import { AiOperationError, AppError } from "../errors/index.js";

/**
 * Wraps an AI/LLM operation, translating Claude CLI and JSON parse errors
 * into `AiOperationError` so the global error handler can return consistent
 * 500 responses without per-route try/catch blocks.
 *
 * AppError subclasses (e.g. NotFoundError, ValidationError) are re-thrown
 * unchanged so the domain error handler can map them to the correct HTTP status.
 */
export async function wrapAiOperation<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    // Let application-level errors pass through — they carry the correct HTTP status.
    if (err instanceof AppError) {
      throw err;
    }
    const e = err as { message?: string; stderr?: unknown };
    if (err instanceof SyntaxError || e.message?.includes("JSON")) {
      console.error(`[${label}] failed to parse AI output:`, e.message);
      throw new AiOperationError("Failed to parse AI response");
    }
    const parts: string[] = [];
    if (e.message) parts.push(e.message);
    if (e.stderr) parts.push(String(e.stderr).trim());
    const detail = parts.length > 0 ? parts.join(" | ") : "AI CLI failed";
    console.error(`[${label}] AI error:`, detail);
    throw new AiOperationError("AI operation failed", detail);
  }
}
