/** Base class for all application-level HTTP errors. */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(message, 404, "NOT_FOUND");
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, "VALIDATION_ERROR");
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, "CONFLICT");
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string) {
    super(message, 403, "FORBIDDEN");
  }
}

/** Thrown when an AI/LLM operation (Claude CLI) fails. */
export class AiOperationError extends AppError {
  constructor(
    message: string,
    public readonly detail?: string,
  ) {
    super(message, 500, "AI_ERROR");
  }
}
