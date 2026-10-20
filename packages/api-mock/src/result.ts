import type { ApiErrorCode, ContractErrorInfo } from "@hogee/core";

/** A handler's error outcome; the wrapper turns it into an ApiError envelope at the route's status. */
export interface Failure {
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly contractError?: ContractErrorInfo;
  readonly traceId?: string;
}

export const isFailure = (value: unknown): value is Failure =>
  typeof value === "object" && value !== null && "code" in value && "message" in value && !("ok" in value);
