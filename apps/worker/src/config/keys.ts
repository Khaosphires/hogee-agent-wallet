/**
 * Hot signer keys (project.md §8.2 key custody, §25.5). Read once from env at startup, by name only:
 *   AGENT_PRIVATE_KEY_LOOP, ORACLE_PRIVATE_KEY_LOOP, LENDER_PRIVATE_KEY_LOOP, RELAYER_PRIVATE_KEY_LOOP (loop-1)
 *   AGENT_PRIVATE_KEY_FINAL, ORACLE_PRIVATE_KEY_FINAL, LENDER_PRIVATE_KEY_FINAL, RELAYER_PRIVATE_KEY_FINAL (final-1)
 * loop-1 and final-1 use separate key sets so their nonces never collide. Keys are never logged, persisted or put
 * into an error; only viem accounts (address + signing closures) leave this module. With `scrub`, both sets are
 * deleted from the env object after reading, so a later env dump or child process cannot see them.
 */
import { getAddress, type Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

export const SIGNER_ROLES = ['AGENT', 'ORACLE', 'LENDER', 'RELAYER'] as const;
export type SignerRole = (typeof SIGNER_ROLES)[number];
export const KEY_SETS = ['LOOP', 'FINAL'] as const;
export type KeySet = (typeof KEY_SETS)[number];

export class SignerConfigError extends Error {
  override readonly name = 'SignerConfigError';
}

export interface WorkerSigners {
  readonly set: KeySet;
  readonly agent: PrivateKeyAccount;
  readonly oracle: PrivateKeyAccount;
  readonly lender: PrivateKeyAccount;
  readonly relayer: PrivateKeyAccount;
}

const KEY_RE = /^0x[0-9a-fA-F]{64}$/;

export function keyEnvName(role: SignerRole, set: KeySet): string {
  return `${role}_PRIVATE_KEY_${set}`;
}

/** loop-* → LOOP, final-* → FINAL (§8.1 D17). Any other deployment has no key set. */
export function keySetForDeployment(deploymentId: string): KeySet {
  if (/^loop-[a-z0-9-]+$/.test(deploymentId)) return 'LOOP';
  if (/^final-[a-z0-9-]+$/.test(deploymentId)) return 'FINAL';
  throw new SignerConfigError('DEPLOYMENT_ID must be loop-* or final-* (it selects the _LOOP or _FINAL key set)');
}

function readKey(env: Readonly<Record<string, string | undefined>>, name: string): Hex {
  const value = env[name]?.trim();
  if (!value) throw new SignerConfigError(`${name} is required`);
  if (!KEY_RE.test(value)) throw new SignerConfigError(`${name} must be 0x followed by 64 hex characters`);
  return value as Hex;
}

/**
 * privateKeyToAccount, with its error replaced: a 64-hex value outside the secp256k1 range (0, or ≥ the curve order)
 * makes viem/noble throw a message that may quote the value. The SignerConfigError names the variable only and
 * carries no `cause`, so the value cannot reach a log through the error chain.
 */
function accountOf(name: string, key: Hex): PrivateKeyAccount {
  try {
    return privateKeyToAccount(key);
  } catch {
    throw new SignerConfigError(`${name} is not a valid secp256k1 private key`);
  }
}

/** Addresses of the other set's keys that are present and well-formed (they must not overlap this set). */
function otherSetAddresses(env: Readonly<Record<string, string | undefined>>, set: KeySet): Set<string> {
  const other = set === 'LOOP' ? 'FINAL' : 'LOOP';
  const out = new Set<string>();
  for (const role of SIGNER_ROLES) {
    const name = keyEnvName(role, other);
    const value = env[name]?.trim();
    if (value && KEY_RE.test(value)) out.add(accountOf(name, value as Hex).address);
  }
  return out;
}

/**
 * The four role accounts of `set`. Throws SignerConfigError (naming the variable, never the value) when a key is
 * missing, malformed or outside the secp256k1 range (either set), when two roles share a key, or when a key also
 * appears in the other deployment's set.
 */
export function loadSigners(env: Record<string, string | undefined>, set: KeySet, opts: { scrub?: boolean } = {}): WorkerSigners {
  try {
    const [agent, oracle, lender, relayer] = SIGNER_ROLES.map((role) => accountOf(keyEnvName(role, set), readKey(env, keyEnvName(role, set)))) as [
      PrivateKeyAccount,
      PrivateKeyAccount,
      PrivateKeyAccount,
      PrivateKeyAccount,
    ];
    const addresses = [agent, oracle, lender, relayer].map((a) => getAddress(a.address));
    if (new Set(addresses).size !== addresses.length) throw new SignerConfigError(`the four ${set} role keys must be distinct`);
    const other = otherSetAddresses(env, set);
    if (addresses.some((a) => other.has(a))) throw new SignerConfigError('loop-1 and final-1 must use separate key sets');
    const signers: WorkerSigners = { set, agent, oracle, lender, relayer };
    return Object.freeze({ ...signers, toJSON: () => ({ set, agent: agent.address, oracle: oracle.address, lender: lender.address, relayer: relayer.address }) });
  } finally {
    if (opts.scrub) for (const s of KEY_SETS) for (const role of SIGNER_ROLES) delete env[keyEnvName(role, s)];
  }
}
