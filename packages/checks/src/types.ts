// Public result types of @hogee/checks (signatures frozen at G0, project.md §26.8).

export type ValidationResult = {
  readonly valid: boolean;
  readonly reason?: string;
};

export type SanctionsResult = {
  readonly hit: boolean;
  /** Which list matched, e.g. "UN_SC". Null when there is no hit. */
  readonly list: string | null;
  readonly matchedName: string | null;
};

export type LeiRecord = {
  readonly lei: string;
  readonly legalName: string;
  readonly country: string;
  readonly status: string;
};

/** Currency pair as "BASE/QUOTE", e.g. "CNY/MYR". */
export type FxPair = `${string}/${string}`;

/** A check refused its input (bad format, or text that looks like personal data). Messages never echo the input. */
export class CheckInputError extends Error {
  override readonly name = "CheckInputError";
}

/** A check could not run (list missing, service down, malformed answer). Callers must treat it as "unavailable". */
export class CheckUnavailableError extends Error {
  override readonly name = "CheckUnavailableError";
}
