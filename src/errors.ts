/**
 * errors.ts — structured domain errors + MCP tool-error mapping.
 *
 * P4: errors must be loud and structured — never a silent no-op. Tool handlers
 * throw one of these; the registry catches and converts to a tool result via
 * toToolError(), which surfaces a machine `code` + human `message` to the agent.
 */

export type ErrorCode = 'NOT_FOUND' | 'VALIDATION' | 'CONFLICT' | 'DB';

/** Base class carrying a machine-readable code. */
export abstract class AppError extends Error {
  abstract readonly code: ErrorCode;
  /** Optional structured payload (e.g. zod issues, conflicting key). */
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.details = details;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/** Row not found for the bound user (also used for cross-tenant id misses). */
export class NotFoundError extends AppError {
  readonly code = 'NOT_FOUND' as const;
}

/** Input failed validation (zod parse failure, range/enum violation, malformed jsonb). */
export class ValidationError extends AppError {
  readonly code = 'VALIDATION' as const;
}

/** Invariant/uniqueness conflict (e.g. active program exists, PK clash). */
export class ConflictError extends AppError {
  readonly code = 'CONFLICT' as const;
}

/** Unexpected database/transport failure. */
export class DbError extends AppError {
  readonly code = 'DB' as const;
}

export interface ToolErrorResult {
  isError: true;
  content: { type: 'text'; text: string }[];
}

/**
 * Map any thrown error into the MCP tool-error result shape. Known AppErrors
 * keep their code + message + details; anything else becomes a DB error with a
 * generic message (no internal/stack leakage to the agent).
 */
export function toToolError(err: unknown): ToolErrorResult {
  let code: ErrorCode;
  let message: string;
  let details: unknown;

  if (err instanceof AppError) {
    code = err.code;
    message = err.message;
    details = err.details;
  } else if (err instanceof Error) {
    code = 'DB';
    message = err.message;
  } else {
    code = 'DB';
    message = 'Unknown error';
  }

  const payload =
    details === undefined ? { code, message } : { code, message, details };

  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  };
}
