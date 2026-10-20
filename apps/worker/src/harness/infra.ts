/**
 * Throwaway local infrastructure for `loop:anvil`: an Anvil node and a Postgres 16 cluster in a temp directory,
 * both on 127.0.0.1 only, both stopped (and the data directory deleted) by `stop()`. Children get a minimal env:
 * never this process's env, which holds the generated signer keys.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface Infra {
  readonly rpcUrl: string;
  readonly databaseUrl: string;
  stop(): Promise<void>;
}

export interface InfraOptions {
  readonly anvilPort: number;
  readonly pgPort: number;
  /** Directory holding initdb/pg_ctl/createdb (Homebrew postgresql@16 by default). */
  readonly pgBin: string;
  /** Parent of the throwaway data directory (keep it short: unix socket paths are limited). */
  readonly tmpRoot?: string;
}

const baseEnv = (): Record<string, string> => ({
  PATH: `${homedir()}/.foundry/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
  HOME: homedir(),
  LANG: 'en_US.UTF-8',
  LC_ALL: 'en_US.UTF-8',
});

async function waitFor(check: () => Promise<boolean>, what: string, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${what} did not come up`);
}

async function rpcUp(url: string): Promise<boolean> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
  return res.ok;
}

export async function startInfra(o: InfraOptions): Promise<Infra> {
  const dir = mkdtempSync(join(o.tmpRoot ?? tmpdir(), 'hogee-loop-'));
  const data = join(dir, 'pg');
  const env = baseEnv();
  let anvil: ChildProcess | undefined;
  let pgStarted = false;
  const stop = async () => {
    anvil?.kill('SIGTERM');
    if (pgStarted) await run(join(o.pgBin, 'pg_ctl'), ['-D', data, '-m', 'fast', 'stop'], { env }).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    anvil = spawn('anvil', ['--port', String(o.anvilPort), '--host', '127.0.0.1', '--silent'], { env, stdio: 'ignore' });
    const rpcUrl = `http://127.0.0.1:${o.anvilPort}`;
    await waitFor(() => rpcUp(rpcUrl), 'anvil');
    await run(join(o.pgBin, 'initdb'), ['-D', data, '-U', 'hogee_loop', '--auth=trust'], { env });
    await run(join(o.pgBin, 'pg_ctl'), ['-D', data, '-l', join(dir, 'pg.log'), '-o', `-c listen_addresses=127.0.0.1 -p ${o.pgPort} -c unix_socket_directories=''`, '-w', 'start'], { env });
    pgStarted = true;
    await run(join(o.pgBin, 'createdb'), ['-h', '127.0.0.1', '-p', String(o.pgPort), '-U', 'hogee_loop', 'hogee_loop'], { env });
    return { rpcUrl, databaseUrl: `postgres://hogee_loop@127.0.0.1:${o.pgPort}/hogee_loop`, stop };
  } catch (error: unknown) {
    await stop();
    throw error;
  }
}
