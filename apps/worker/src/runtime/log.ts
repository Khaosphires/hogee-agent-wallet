/**
 * Structured JSON-lines logger. Every string is passed through `redactText` (an RPC URL may carry an API key), errors
 * become `shortErrorReason` (first line, redacted), bigints become strings, and a field whose name looks like a secret
 * (key, secret, password, mnemonic, token, url) is dropped. Keys never reach a logger in the first place; this is
 * the second layer.
 */
import { redactText, shortErrorReason } from '@hogee/chain';

export type LogLevel = 'info' | 'warn' | 'error';
export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

/** Names that hold secrets: private/api/signing keys, secrets, passwords, mnemonics, tokens, credentials, URLs. */
const SECRET_NAME_RE = /(private|api|signing|secret)[_-]?key|secret|password|passwd|mnemonic|seed[_-]?phrase|authorization|cookie|token|credential|url$/i;

function clean(value: unknown, depth = 0): unknown {
  if (value instanceof Error) return shortErrorReason(value, 300);
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (depth > 4) return '[depth]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => clean(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = SECRET_NAME_RE.test(k) ? '[redacted]' : clean(v, depth + 1);
  return out;
}

export interface LoggerOptions {
  /** Where each JSON line goes (default stdout). */
  readonly sink?: (line: string) => void;
  readonly base?: LogFields;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const sink = opts.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const base = opts.base ?? {};
  const write = (level: LogLevel, event: string, fields: LogFields = {}) => {
    const body = clean({ ...base, ...fields }) as Record<string, unknown>;
    sink(JSON.stringify({ ts: new Date().toISOString(), level, event: redactText(event), ...body }));
  };
  return {
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
    child: (fields) => createLogger({ sink, base: { ...base, ...fields } }),
  };
}

/** A logger that discards everything (tests that do not assert on logs). */
export const silentLogger: Logger = createLogger({ sink: () => undefined });
