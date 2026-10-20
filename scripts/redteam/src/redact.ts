/**
 * Error text the runner writes into a bundle (errors/<taskId>.json, the report reason, the plug child's stderr in
 * artifacts/D-plug/crash.json) or prints. viem puts the request URL in an error's message and stack, and an RPC URL can
 * carry a provider key; stack lines carry the operator's absolute paths (home directory, user name). So error text is
 * cut to repo-relative paths first, then every URL becomes `<url>` (@hogee/chain redactText / shortErrorReason).
 * Only error text: Bundle.write stays verbatim, because explorer links and attack inputs (lookalike URLs) are evidence.
 * The post-run secret scan (safety.ts) is the backstop for everything else.
 */
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { redactText, shortErrorReason } from "@hogee/chain";
import { REPO_ROOT } from "./config";

const ROOT_PREFIXES = [`${pathToFileURL(REPO_ROOT).href}/`, `file://${REPO_ROOT}/`, `${REPO_ROOT}/`];
const HOME = homedir();
/** Any other home directory (another user, a CI runner): /Users/<name> or /home/<name>, with or without file://. */
const OTHER_HOME = /(?:file:\/\/)?\/(?:Users|home)\/[^/\s'"<>()]+/g;
const STACK_LINES = 12;
const CAUSE_DEPTH = 4;

/** `text` with the repo root removed (repo-relative paths) and any home directory shown as `~`. */
export function stripLocalPaths(text: string): string {
  let out = text;
  for (const prefix of ROOT_PREFIXES) out = out.split(prefix).join("");
  if (HOME.length > 1) out = out.split(`file://${HOME}/`).join("~/").split(`${HOME}/`).join("~/");
  return out.replace(OTHER_HOME, "~");
}

/** Error text for a bundle file or a terminal line: local paths cut, then every URL replaced by `<url>`. */
export function redactErrorText(text: string): string {
  return redactText(stripLocalPaths(text));
}

/** shortErrorReason (`<name>: <first line>`, URLs redacted, capped) with local paths cut first. */
export function errorReason(error: unknown, max = 300): string {
  if (!(error instanceof Error)) return shortErrorReason(stripLocalPaths(String(error)), max);
  const clean = new Error(stripLocalPaths((error as { shortMessage?: string }).shortMessage ?? error.message));
  clean.name = error.name;
  return shortErrorReason(clean, max);
}

export interface ErrorRecord {
  readonly message: string;
  readonly stack?: readonly string[];
  readonly causes?: readonly string[];
}

/** The body of errors/<taskId>.json: the whole message, the first stack frames and the cause chain, all redacted. */
export function errorRecord(error: unknown): ErrorRecord {
  if (!(error instanceof Error)) return { message: redactErrorText(String(error)) };
  const frames = (error.stack ?? "").split("\n").filter((line) => /^\s+at /.test(line));
  const causes: string[] = [];
  for (let c: unknown = error.cause, depth = 0; c !== undefined && c !== null && depth < CAUSE_DEPTH; depth += 1) {
    causes.push(errorReason(c));
    c = c instanceof Error ? c.cause : undefined;
  }
  return {
    message: redactErrorText(`${error.name}: ${error.message}`),
    ...(frames.length > 0 ? { stack: frames.slice(0, STACK_LINES).map((line) => redactErrorText(line.trim())) } : {}),
    ...(causes.length > 0 ? { causes } : {}),
  };
}
