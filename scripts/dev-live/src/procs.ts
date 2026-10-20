/**
 * Child processes of the stack: each gets an env built from scratch (never this process's env) and logs to
 * .data/<name>.log; a child that dies on its own takes the stack down. `stopAll` stops them in reverse start order.
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

export const run = promisify(execFile);

// The launcher's own node comes first: next's Turbopack spawns `node` for CSS (PostCSS) and fails every page with
// "spawning node pooled process … No such file or directory" when node lives outside the fixed list (nvm, fnm, volta).
const PATHS = [
  dirname(process.execPath),
  join(homedir(), ".foundry", "bin"),
  "/opt/homebrew/bin",
  "/opt/homebrew/opt/postgresql@16/bin",
  "/usr/local/bin",
  "/usr/lib/postgresql/16/bin",
  "/usr/bin",
  "/bin",
];

/** The base env of every child: a fixed PATH and the home directory, nothing inherited. */
export function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: PATHS.join(":"), HOME: homedir(), LANG: "en_US.UTF-8", ...extra };
}

export interface Managed {
  readonly name: string;
  readonly child: ChildProcess;
  readonly log: WriteStream;
  /** Signals the whole process group (next dev starts its own workers). */
  readonly group: boolean;
}

const managed: Managed[] = [];
let stopping = false;

export function startChild(
  name: string,
  cmd: string,
  args: readonly string[],
  o: { cwd: string; env: Record<string, string>; logDir: string; group?: boolean; onLine?: (line: string) => void },
  onExit: (name: string, code: number | null, signal: NodeJS.Signals | null) => void,
): Managed {
  const log = createWriteStream(join(o.logDir, `${name}.log`), { flags: "a" });
  const child = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"], detached: o.group === true });
  const pipe = (b: Buffer) => {
    log.write(b);
    if (o.onLine) for (const line of b.toString().split("\n")) if (line.trim()) o.onLine(line);
  };
  child.stdout?.on("data", pipe);
  child.stderr?.on("data", pipe);
  child.on("exit", (code, signal) => {
    if (!stopping) onExit(name, code, signal);
  });
  const m: Managed = { name, child, log, group: o.group === true };
  managed.push(m);
  return m;
}

function signal(m: Managed, sig: NodeJS.Signals): void {
  try {
    if (m.group && m.child.pid) process.kill(-m.child.pid, sig);
    else m.child.kill(sig);
  } catch {
    // already gone
  }
}

function exited(m: Managed, ms: number): Promise<boolean> {
  if (m.child.exitCode !== null || m.child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    m.child.once("exit", () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

/** SIGTERM (SIGINT for next dev) in reverse order, SIGKILL after `graceMs`. */
export async function stopAll(graceMs = 35_000): Promise<void> {
  stopping = true;
  for (const m of [...managed].reverse()) {
    signal(m, m.group ? "SIGINT" : "SIGTERM");
    if (!(await exited(m, graceMs))) signal(m, "SIGKILL");
    m.log.end();
  }
}

export async function waitFor(what: string, check: () => Promise<boolean>, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${what} did not come up within ${Math.round(ms / 1000)} s`);
}

/** True when nothing listens on 127.0.0.1:<port> (and on localhost, which next binds). */
export async function portFree(port: number): Promise<boolean> {
  const tryListen = (host: string) =>
    new Promise<boolean>((resolve) => {
      const srv = createServer();
      srv.once("error", () => resolve(false));
      srv.listen(port, host, () => srv.close(() => resolve(true)));
    });
  return (await tryListen("127.0.0.1")) && (await tryListen("localhost"));
}
