/**
 * A scripted chain for the safety-pause driver's db tests (TEST_DATABASE_URL, no Anvil): Treasury.paused() per block
 * tag, mined / pending transaction counts per signer, and a node that accepts or refuses each raw tx (`refuse`). It
 * never mines: a test moves `mined` / `paused` itself. Errors use the viem classes the real client throws.
 */
import {
  getAddress,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type TransactionSerializableEIP1559,
} from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';

export interface SeenTx {
  readonly raw: Hex;
  readonly hash: Hex;
  readonly from: Address;
  readonly nonce: bigint;
  readonly to: Address | null;
  readonly data: Hex;
  readonly value: bigint;
}

type CountTag = 'latest' | 'pending';

export class FakePauseChain {
  /** Treasury.paused() at `latest` and at `safe` (and `finalized`). */
  paused = { latest: false, safe: false };
  /** Mined tx count per lowercase address. */
  readonly mined = new Map<string, bigint>();
  /** Mined + executable-in-the-pool count per lowercase address. */
  readonly pending = new Map<string, bigint>();
  readonly accepted: SeenTx[] = [];
  readonly refused: SeenTx[] = [];
  /** Return a node error text to refuse the tx (e.g. "insufficient funds for gas * price + value"). */
  refuse: (tx: SeenTx) => string | null = () => null;

  count(address: Address, tag: CountTag): bigint {
    return (tag === 'pending' ? this.pending : this.mined).get(address.toLowerCase()) ?? 0n;
  }

  readonly client = {
    readContract: async (a: { functionName: string; blockTag?: string }): Promise<boolean> => {
      if (a.functionName !== 'paused') throw new Error(`fake chain: no view ${a.functionName}`);
      return a.blockTag === 'safe' || a.blockTag === 'finalized' ? this.paused.safe : this.paused.latest;
    },
    getTransactionCount: async (a: { address: Address; blockTag?: string }): Promise<number> => Number(this.count(a.address, a.blockTag === 'pending' ? 'pending' : 'latest')),
    getTransactionReceipt: async ({ hash }: { hash: Hex }): Promise<never> => {
      throw new TransactionReceiptNotFoundError({ hash });
    },
    estimateFeesPerGas: async () => ({ maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }),
    estimateGas: async (): Promise<bigint> => 60_000n,
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }): Promise<Hex> => {
      const tx = await seen(serializedTransaction);
      const reason = this.refuse(tx);
      if (reason) {
        this.refused.push(tx);
        throw Object.assign(new Error('Transaction creation failed.'), { details: reason });
      }
      this.accepted.push(tx);
      const key = tx.from.toLowerCase();
      if (tx.nonce === this.count(tx.from, 'pending')) this.pending.set(key, tx.nonce + 1n);
      return tx.hash;
    },
  };
}

async function seen(raw: Hex): Promise<SeenTx> {
  const tx = parseTransaction(raw);
  const from = getAddress(await recoverTransactionAddress({ serializedTransaction: raw as never }));
  return { raw, hash: keccak256(raw), from, nonce: BigInt(tx.nonce ?? 0), to: tx.to ?? null, data: tx.data ?? '0x', value: tx.value ?? 0n };
}

/** `account` with every transaction it signs recorded (in order) before it is signed. */
export function recording(account: PrivateKeyAccount): { account: PrivateKeyAccount; signed: TransactionSerializableEIP1559[] } {
  const signed: TransactionSerializableEIP1559[] = [];
  const wrapped = {
    ...account,
    signTransaction: async (tx: TransactionSerializableEIP1559) => {
      signed.push(tx);
      return account.signTransaction(tx);
    },
  } as PrivateKeyAccount;
  return { account: wrapped, signed };
}
