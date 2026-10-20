/**
 * The seal code (DESIGN.md §4): the first four hex characters of the signing transaction's hash, printed on the 40 px
 * chop and beside the smaller ones ("stamp C21E"). Anything that isn't a whole 32-byte 0x hash gives null, so a chop
 * never shows characters that don't come from a real transaction.
 */
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export function sealCode(txHash: string | null | undefined): string | null {
  if (!txHash || !TX_HASH_RE.test(txHash)) return null;
  return txHash.slice(2, 6).toUpperCase();
}

/** "C21E" → ["C2", "1E"]: the 2 × 2 setting on the 40 px chop. */
export function sealCodeRows(code: string): [string, string] {
  return [code.slice(0, 2), code.slice(2, 4)];
}
