/**
 * Gate G3 on Anvil (task 1.9): P2's 20 browser vectors (e2e/vectors), re-encoded from their DER
 * form by src/passkey, verify on a PlanRegistry deployed to a real Anvil node with the vectors' passkey registered as
 * the founder key. checkFounderSig runs HogeeSigs.check, the same check as commitPlan, Treasury and MilestoneEscrow.
 * Anvil 1.8.5 defaults to a post-Fusaka hardfork, so OZ P256 takes the EIP-7951 precompile at 0x100 here, as on
 * Sepolia; contracts/test/PasskeyVectors.t.sol (evm_version cancun) covers OZ's Solidity fallback.
 *
 * Needs only an Anvil node and the forge artifacts (contracts/out, from `forge build`; abi:generate runs it):
 *   anvil --port 8601 --silent &
 *   TEST_RPC_URL=http://127.0.0.1:8601 pnpm --filter @hogee/chain exec vitest run test/live/passkey.live.test.ts
 * Skipped unless TEST_RPC_URL is set. It sends two transactions from a fresh funded key and never changes automine.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  parseEther,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
import { beforeAll, describe, expect, it } from 'vitest';
import { P256_N, encodeWebAuthnAuth, hexToBytes, toHex32, webAuthnSig } from '../../src/passkey';
import { toBytes32Tag } from '../../src/index';

const RPC_URL = process.env.TEST_RPC_URL;
const ARTIFACT = new URL('../../../../contracts/out/PlanRegistry.sol/PlanRegistry.json', import.meta.url);
const VECTOR_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'e2e', 'vectors');
/** PlanRegistry's Treasury slot; a passkey-only registration (no backup EOA) never calls it. */
const NO_TREASURY: Address = '0x00000000000000000000000000000000000000aa';
/** 2026-11-30T23:59:59Z, as contracts/test/utils/HogeeTestBase.sol. */
const JUDGING_END = 1_796_083_199n;

interface PasskeyVector {
  readonly digest: Hex;
  readonly qx: Hex;
  readonly qy: Hex;
  readonly r: Hex;
  readonly s: Hex;
  readonly challengeIndex: number;
  readonly typeIndex: number;
  readonly authenticatorData: Hex;
  readonly clientDataJSON: string;
}

const VECTORS: readonly PasskeyVector[] = readdirSync(VECTOR_DIR)
  .filter((f) => /^passkey-\d+\.json$/.test(f))
  .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
  .map((f) => JSON.parse(readFileSync(join(VECTOR_DIR, f), 'utf8')) as PasskeyVector);

function derInteger(x: bigint): Uint8Array {
  const hex = x.toString(16);
  let body = hexToBytes(hex.length % 2 === 0 ? hex : `0${hex}`);
  if ((body[0] ?? 0) & 0x80) body = Uint8Array.of(0, ...body);
  return Uint8Array.of(0x02, body.length, ...body);
}

/** The vector as the authenticator returned it, with s in the high form, so the encoder has to normalise it. */
function rawHighS(v: PasskeyVector) {
  const body = Uint8Array.of(...derInteger(BigInt(v.r)), ...derInteger(P256_N - BigInt(v.s)));
  return {
    signature: Uint8Array.of(0x30, body.length, ...body),
    authenticatorData: hexToBytes(v.authenticatorData),
    clientDataJSON: new TextEncoder().encode(v.clientDataJSON),
  };
}

function loadArtifact(): { abi: Abi; bytecode: Hex } {
  let parsed: { abi?: Abi; bytecode?: { object?: Hex } };
  try {
    parsed = JSON.parse(readFileSync(ARTIFACT, 'utf8')) as typeof parsed;
  } catch {
    throw new Error('contracts/out/PlanRegistry.sol/PlanRegistry.json is missing: run `forge build` in contracts/');
  }
  if (!parsed.abi || !parsed.bytecode?.object) throw new Error('PlanRegistry artifact has no abi or bytecode');
  return { abi: parsed.abi, bytecode: parsed.bytecode.object };
}

describe.skipIf(!RPC_URL)('G3: P2 browser passkey vectors verify on Anvil (PlanRegistry.checkFounderSig)', { timeout: 60_000 }, () => {
  const transport = http(RPC_URL);
  const client = createPublicClient({ chain: anvil, transport });
  // Read in beforeAll: vitest collects a skipped suite too, and a plain `pnpm test` may have no forge artifacts.
  let abi: Abi;
  let registry: Address;

  beforeAll(async () => {
    expect(VECTORS).toHaveLength(20);
    const first = VECTORS[0];
    if (!first) throw new Error('no vectors');
    const artifact = loadArtifact();
    abi = artifact.abi;
    const { bytecode } = artifact;
    // Ephemeral and local-only: generated per run, funded with anvil_setBalance, never written anywhere.
    const lender = privateKeyToAccount(generatePrivateKey());
    await createTestClient({ mode: 'anvil', chain: anvil, transport }).setBalance({ address: lender.address, value: parseEther('10') });
    const wallet = createWalletClient({ account: lender, chain: anvil, transport });
    const deployHash = await wallet.deployContract({
      abi,
      bytecode,
      args: [lender.address, NO_TREASURY, toBytes32Tag('g3-anvil'), toBytes32Tag('anvil'), false, JUDGING_END],
    });
    const deployed = await client.waitForTransactionReceipt({ hash: deployHash });
    if (!deployed.contractAddress || deployed.status !== 'success') throw new Error('PlanRegistry deploy failed');
    registry = deployed.contractAddress;
    const registerHash = await wallet.writeContract({
      address: registry,
      abi,
      functionName: 'registerFounderKey',
      args: [first.qx, first.qy, zeroAddress],
    });
    const registered = await client.waitForTransactionReceipt({ hash: registerHash });
    if (registered.status !== 'success') throw new Error('registerFounderKey reverted');
  }, 60_000);

  it('the registry holds the browser credential as the founder key', async () => {
    const first = VECTORS[0];
    if (!first) throw new Error('no vectors');
    const key = (await client.readContract({ address: registry, abi, functionName: 'founderKey' })) as readonly [Hex, Hex, Address];
    expect(key).toEqual([first.qx, first.qy, zeroAddress]);
  });

  it.each(VECTORS.map((v, i) => [i + 1, v] as const))('vector %i verifies', async (_n, v) => {
    const auth = encodeWebAuthnAuth(rawHighS(v), v.digest);
    const [ok, signer] = (await client.readContract({
      address: registry,
      abi,
      functionName: 'checkFounderSig',
      args: [v.digest, webAuthnSig(auth)],
    })) as readonly [boolean, Address];
    expect(ok).toBe(true);
    expect(signer).toBe(zeroAddress);
  });

  it('a vector presented for another digest, or in its high-s form, does not verify', async () => {
    const first = VECTORS[0];
    if (!first) throw new Error('no vectors');
    const auth = encodeWebAuthnAuth(rawHighS(first));
    const { kind, data } = webAuthnSig(auth);
    const check = async (digest: Hex, sigData: Hex) => {
      const res = await client.readContract({ address: registry, abi, functionName: 'checkFounderSig', args: [digest, { kind, data: sigData }] });
      return (res as readonly [boolean, Address])[0];
    };
    expect(await check(first.digest, data)).toBe(true);
    expect(await check(toHex32(BigInt(first.digest) ^ 1n), data)).toBe(false);
    // webAuthnSigData refuses high-s, so splice it into the s word (after 0x, the offset word and r) by hand.
    const sWord = 2 + 64 * 2;
    const highS = `${data.slice(0, sWord)}${toHex32(P256_N - BigInt(auth.s)).slice(2)}${data.slice(sWord + 64)}` as Hex;
    expect(await check(first.digest, highS)).toBe(false);
  });
});
