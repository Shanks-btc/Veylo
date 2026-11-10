export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    /** Safe, structured context such as the numbers behind insufficient_funds. */
    readonly details?: object,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** Every /auth/verify failure is this one error, so a caller learns nothing about which check failed. */
export const authFailed = () => new AppError(401, "AUTH_FAILED", "Authentication failed");
export const unauthenticated = () => new AppError(401, "UNAUTHENTICATED", "Sign in required");
export const notFound = () => new AppError(404, "NOT_FOUND", "Not found");
export const forbidden = () => new AppError(403, "FORBIDDEN", "Not allowed");
export const invalidRequest = () => new AppError(400, "INVALID_REQUEST", "Invalid request");
export const conflict = (code: string, message: string) => new AppError(409, code, message);
