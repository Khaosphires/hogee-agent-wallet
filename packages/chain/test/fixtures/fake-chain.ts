/**
 * In-memory chain for the recovery / finality unit tests. It models just what those modules read: blocks
 * (with a `finalized` tag lagging the head), mined and mempool txs per (signer, nonce), receipts, nonce
 * counts at any block, decoded logs and contract views (with the block they were read at). Errors use the
 * viem classes the real client throws.
 */
import {
  getAddress,
  keccak256,
  parseTransaction,
  toHex,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
} from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';

export interface FakeLog {
  readonly address: Address;
  readonly eventName: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface FakeTx {
  readonly hash: Hex;
  readonly raw: Hex | null;
  readonly from: Address;
  readonly nonce: bigint;
  readonly to: Address | null;
  readonly input: Hex;
  readonly value: bigint;
  /** null = only in the mempool. */
  block: bigint | null;
  status: 'success' | 'reverted';
  revertData: Hex | null;
  logs: readonly FakeLog[];
  /** The block hash its receipt reports; default the canonical hash of `block` (set it to model a stale receipt). */
  receiptBlockHash?: Hex;
}

/** Canonical hash of block `n` in the fake chain. */
export function canonicalBlockHash(n: bigint): Hex {
  return keccak256(toHex(`fake-block-${n}`));
}

export type ViewFn = (functionName: string, args: readonly unknown[], blockNumber: bigint | undefined) => unknown;

const lower = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : v);

export class FakeChain {
  head = 200n;
  finalizedLag = 64n;
  readonly txs: FakeTx[] = [];
  /** Every raw tx handed to sendRawTransaction. */
  readonly sent: Hex[] = [];
  /** Every getTransactionCount call (the binary search must stay logarithmic). */
  readonly countCalls: { address: Address; block: bigint | 'pending' }[] = [];
  /** Every readContract call with the contract and the block it read at. */
  readonly reads: { address?: Address; functionName: string; args: readonly unknown[]; blockNumber: bigint | undefined }[] = [];
  view: ViewFn = () => {
    throw new Error('no view configured');
  };
  /**
   * Lowercase signer addresses whose nonce reads fail like a broken RPC (the error text carries a provider
   * URL with a key in it, which must never reach an outcome).
   */
  readonly poisoned = new Set<string>();

  private failIfPoisoned(address: Address): void {
    if (this.poisoned.has(address.toLowerCase())) {
      throw new Error('HTTP request failed.\nURL: https://eth-sepolia.example/v2/sk-not-a-real-key\nRequest body: {}');
    }
  }

  get finalized(): bigint {
    return this.head - this.finalizedLag;
  }

  /** Adds a tx (mined at `block`, or mempool-only with block null). */
  add(tx: Partial<FakeTx> & Pick<FakeTx, 'hash' | 'from' | 'nonce'>): FakeTx {
    const full: FakeTx = {
      raw: null,
      to: null,
      input: '0x',
      value: 0n,
      block: null,
      status: 'success',
      revertData: null,
      logs: [],
      ...tx,
      from: getAddress(tx.from),
    };
    this.txs.push(full);
    return full;
  }

  find(hash: Hex): FakeTx | undefined {
    return this.txs.find((t) => t.hash.toLowerCase() === hash.toLowerCase());
  }

  private minedCount(address: Address, upTo: bigint): bigint {
    const nonces = this.txs.filter((t) => t.from === getAddress(address) && t.block !== null && t.block <= upTo).map((t) => t.nonce);
    return nonces.length === 0 ? 0n : nonces.reduce((a, b) => (a > b ? a : b)) + 1n;
  }

  private tagBlock(tag: string): bigint {
    if (tag === 'finalized') return this.finalized;
    if (tag === 'safe') return this.head - this.finalizedLag / 2n;
    return this.head;
  }

  readonly client = {
    getBlockNumber: async (): Promise<bigint> => this.head,
    getBlock: async (a: { blockTag?: string; blockNumber?: bigint; includeTransactions?: boolean }) => {
      const number = a.blockNumber ?? this.tagBlock(a.blockTag ?? 'latest');
      const transactions = this.txs
        .filter((t) => t.block === number)
        .map((t) => ({ hash: t.hash, from: t.from, nonce: Number(t.nonce), to: t.to, input: t.input, value: t.value, blockNumber: number }));
      return { number, hash: canonicalBlockHash(number), transactions };
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const t = this.find(hash);
      if (!t || t.block === null) throw new TransactionReceiptNotFoundError({ hash });
      const blockHash = t.receiptBlockHash ?? canonicalBlockHash(t.block);
      return { transactionHash: t.hash, blockNumber: t.block, blockHash, status: t.status, from: t.from, to: t.to, logs: [] };
    },
    getTransaction: async ({ hash }: { hash: Hex }) => {
      const t = this.find(hash);
      if (!t) throw new TransactionNotFoundError({ hash });
      const base = { hash: t.hash, from: t.from, nonce: Number(t.nonce), to: t.to, input: t.input, value: t.value, gas: 500_000n, blockNumber: t.block };
      if (!t.raw) return base;
      // A node's copy of a signed tx: its fields and signature (the data as `input`), from which the bytes rebuild.
      const { data, ...signed } = parseTransaction(t.raw);
      return { ...base, ...signed, input: data ?? '0x', hash: t.hash, from: t.from, blockNumber: t.block };
    },
    getTransactionCount: async (a: { address: Address; blockTag?: string; blockNumber?: bigint }): Promise<number> => {
      this.failIfPoisoned(a.address);
      if (a.blockTag === 'pending') {
        this.countCalls.push({ address: a.address, block: 'pending' });
        const all = this.txs.filter((t) => t.from === getAddress(a.address)).map((t) => t.nonce + 1n);
        return Number(all.reduce((x, y) => (x > y ? x : y), 0n));
      }
      const block = a.blockNumber ?? this.tagBlock(a.blockTag ?? 'latest');
      this.countCalls.push({ address: a.address, block });
      return Number(this.minedCount(a.address, block));
    },
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }): Promise<Hex> => {
      this.sent.push(serializedTransaction);
      return keccak256(serializedTransaction);
    },
    readContract: async (a: { address?: Address; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }) => {
      this.reads.push({ ...(a.address ? { address: a.address } : {}), functionName: a.functionName, args: a.args ?? [], blockNumber: a.blockNumber });
      return this.view(a.functionName, a.args ?? [], a.blockNumber);
    },
    getLogs: async (a: { address: Address; event: { name: string }; args?: Record<string, unknown>; fromBlock: bigint; toBlock: bigint }) => {
      const out: { address: Address; eventName: string; args: Record<string, unknown>; transactionHash: Hex; blockNumber: bigint }[] = [];
      for (const t of this.txs) {
        if (t.block === null || t.block < a.fromBlock || t.block > a.toBlock || t.status !== 'success') continue;
        for (const l of t.logs) {
          if (getAddress(l.address) !== getAddress(a.address) || l.eventName !== a.event.name) continue;
          const want = Object.entries(a.args ?? {});
          if (want.every(([k, v]) => lower(l.args[k]) === lower(v))) {
            out.push({ address: l.address, eventName: l.eventName, args: { ...l.args }, transactionHash: t.hash, blockNumber: t.block });
          }
        }
      }
      return out;
    },
    request: async (a: { method: string; params: readonly unknown[] }) => {
      if (a.method !== 'debug_traceTransaction') throw new Error(`unsupported ${a.method}`);
      const t = this.find(a.params[0] as Hex);
      return t?.revertData ? { output: t.revertData } : {};
    },
    call: async () => {
      throw new Error('eth_call not modelled');
    },
  };
}

/** A real signed EIP-1559 tx (so keccak256(raw) is its hash and parseTransaction works). */
export async function signedTx(
  account: PrivateKeyAccount,
  a: { nonce: bigint; to: Address; data: Hex; maxFeePerGas?: bigint; chainId?: number },
): Promise<{ raw: Hex; hash: Hex }> {
  const maxFeePerGas = a.maxFeePerGas ?? 2_000_000_000n;
  const raw = await account.signTransaction({
    type: 'eip1559',
    chainId: a.chainId ?? 31337,
    nonce: Number(a.nonce),
    to: a.to,
    data: a.data,
    value: 0n,
    gas: 200_000n,
    maxFeePerGas,
    maxPriorityFeePerGas: maxFeePerGas / 2n,
  });
  return { raw, hash: keccak256(raw) };
}
