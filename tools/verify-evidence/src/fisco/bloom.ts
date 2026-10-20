/**
 * The receipt logsBloom as FISCO BCOS 3.17.1 serves it over Web3 RPC (browser-safe).
 *
 * It is Ethereum's 2048-bit bloom (three bits per item, from the first three byte pairs of keccak256) with one
 * difference: a log's address enters as the keccak256 of its lowercase hex text without "0x" (40 ASCII bytes), not of
 * its 20 raw bytes. Topics enter as their 32 raw bytes, as on Ethereum. Found on the first mirror run: 27 of 27
 * receipts match this rule, and only the 11 without logs match Ethereum's.
 */
import { keccak256, stringToHex, type Hex } from "viem";

export function fiscoLogsBloom(logs: readonly { address: string; topics: readonly string[] }[]): Hex {
  const bloom = new Uint8Array(256);
  const add = (hash: Hex) => {
    for (const i of [0, 2, 4]) {
      const hi = parseInt(hash.slice(2 + i * 2, 4 + i * 2), 16);
      const lo = parseInt(hash.slice(4 + i * 2, 6 + i * 2), 16);
      const bit = ((hi << 8) | lo) & 2047;
      bloom[255 - (bit >> 3)] = (bloom[255 - (bit >> 3)] as number) | (1 << (bit & 7));
    }
  };
  for (const log of logs) {
    add(keccak256(stringToHex(log.address.toLowerCase().replace(/^0x/, ""))));
    for (const t of log.topics) add(keccak256(t.toLowerCase() as Hex));
  }
  let hex = "0x";
  for (const x of bloom) hex += x.toString(16).padStart(2, "0");
  return hex as Hex;
}
