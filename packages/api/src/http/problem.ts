/**
 * Failures (§26.5 ApiError). A handler throws `ApiProblem` (or returns nothing and lets a typed error bubble);
 * `toFailure` maps every error the libraries throw onto the frozen codes, and never puts a secret, a stack or a
 * provider URL into the message (unknown errors become a generic UPSTREAM; details go to the redacted server log).
 */
import { ModelConfigError, OutboundBlockedError, PlannerInputError, ReaderRejectedError, RedactionUnavailableError } from "@hogee/agent";
import {
  CONTRACT_ERROR_NAMES,
  CompileError,
  PACK_FACT_MISSING,
  PackFactMissingError,
  type ApiErrorCode,
  type ContractErrorInfo,
  type ContractErrorName,
} from "@hogee/core";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ApiFailure {
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, JsonValue>>;
  readonly contractError?: ContractErrorInfo;
  readonly traceId?: string;
  /** Overrides the route's status for this code (501 NOT_IMPLEMENTED, 503 Stripe not configured). */
  readonly status?: number;
}

export class ApiProblem extends Error {
  override readonly name = "ApiProblem";
  constructor(readonly failure: ApiFailure) {
    super(failure.message);
  }
}

export const fail = (code: ApiErrorCode, message: string, extra: Omit<ApiFailure, "code" | "message"> = {}): ApiProblem =>
  new ApiProblem({ code, message, ...extra });

const CONTRACT_ERRORS: ReadonlySet<string> = new Set(CONTRACT_ERROR_NAMES);
export const isContractError = (name: string): name is ContractErrorName => CONTRACT_ERRORS.has(name);

/** A failure named after a §8.5 contract error (409), carrying the decoded error. */
export function contractFailure(name: ContractErrorName, message: string, args?: Record<string, string>, traceId?: string): ApiProblem {
  return new ApiProblem({
    code: name,
    message,
    contractError: { name, ...(args ? { args } : {}) },
    ...(traceId ? { traceId } : {}),
  });
}

/** A route with no handler yet. The ApiError code set is frozen, so: UPSTREAM + 501. */
export function notImplemented(task: string): ApiProblem {
  return new ApiProblem({
    code: "UPSTREAM",
    message: `NOT_IMPLEMENTED: this route arrives with task ${task}; use MOCK_API=1 for it until then`,
    details: { reason: "NOT_IMPLEMENTED", task },
    status: 501,
  });
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** Every error a handler can throw → a failure. `log` receives the original (it redacts URLs and drops secrets). */
export function toFailure(error: unknown, log: (e: unknown) => void): ApiFailure {
  if (error instanceof ApiProblem) return error.failure;
  // A pack gap is a refusal to compile, not a bad request: the route's declared 409 COMPILE_FAILED. Its `details` are
  // {reason, missingFacts}: the frozen {violations} shape needs ≥1 constitution code, and no rule was broken.
  if (error instanceof PackFactMissingError) {
    return {
      code: "COMPILE_FAILED",
      message: `The country pack is missing facts this plan needs, so nothing was compiled or assumed: ${error.message}`,
      details: { reason: PACK_FACT_MISSING, missingFacts: [...error.leaves] },
    };
  }
  if (error instanceof CompileError) {
    if (error.code === "COMPILE_FAILED" && error.violations.length > 0) {
      return {
        code: "COMPILE_FAILED",
        message: "The compiled plan would break the on-chain constitution",
        details: { violations: error.violations.map((code) => ({ code, message: `constitution rule ${code}` })) },
      };
    }
    return { code: "VALIDATION", message: `The plan cannot be compiled: ${error.code}`, details: { reason: error.code } };
  }
  if (error instanceof RedactionUnavailableError) return { code: "UPSTREAM", message: "Model call blocked: PII redaction is unavailable" };
  if (error instanceof OutboundBlockedError) return { code: "UPSTREAM", message: "Model call blocked: an identifier would have left the machine" };
  if (error instanceof ReaderRejectedError) return { code: "VALIDATION", message: "The document could not be read safely" };
  if (error instanceof PlannerInputError) return { code: "VALIDATION", message: "The conversation is not valid planner input" };
  if (error instanceof ModelConfigError) return { code: "UPSTREAM", message: "The model provider is not configured" };
  if (error instanceof ConfigError) return { code: "UPSTREAM", message: `The live API is not configured: ${error.message}` };
  log(error);
  return { code: "UPSTREAM", message: "Internal error" };
}
