import { Request, Response, NextFunction } from "express";
import { logger } from "../observability/logger";

/**
 * Custom application error with HTTP status code.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;

  constructor(message: string, statusCode: number = 500, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(`${resource} not found`, 404);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(message, 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(message, 403);
  }
}

export class BadRequestError extends AppError {
  constructor(message: string) {
    super(message, 400);
  }
}

/**
 * Global error-handling middleware. Must be registered last.
 */
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    // Operational errors are expected; log at warn unless 5xx.
    const log = req.log ?? logger;
    if (err.statusCode >= 500) {
      log.error("Request error", err);
    } else {
      log.warn("Request error", {
        message: err.message,
        statusCode: err.statusCode,
      });
    }
    res.status(err.statusCode).json({
      error: err.message,
      statusCode: err.statusCode,
    });
    return;
  }

  // Unknown / unexpected error. Log with full context (stack + request id) and
  // surface the underlying message so failures are debuggable instead of an
  // opaque "Internal server error".
  const log = req.log ?? logger;
  log.error("Unhandled error", {
    message: err?.message,
    stack: err?.stack,
    name: err?.name,
    path: req.originalUrl,
    method: req.method,
  });
  res.status(500).json({
    error: "Internal server error",
    detail: err?.message ?? String(err),
    statusCode: 500,
  });
}
