// @hogee/chain public surface (G0). Generated ABIs come from `pnpm --filter @hogee/chain abi:generate`.
export { iMilestoneEscrowAbi, iPlanRegistryAbi, iSalesOracleAbi, iTreasuryAbi } from './generated';
export {
  iMilestoneEscrowAbi as milestoneEscrowAbi,
  iPlanRegistryAbi as planRegistryAbi,
  iSalesOracleAbi as salesOracleAbi,
  iTreasuryAbi as treasuryAbi,
} from './generated';
export * from './eip712';
export * from './hashes';
export * from './kinds';
export * from './deployments';
// Task 1.5: worker chain core (clients, Postgres nonces, tx builder, crash-safe sender, recovery, watchers).
export * from './clients';
export * from './values';
export * from './errors';
export * from './fees';
export * from './tx-builder';
export * from './nonces';
export * from './targets';
export * from './payment-call';
export * from './sign-binding';
export * from './spend-guard';
export * from './revert';
export * from './broadcast';
export * from './sender';
export * from './intents';
export * from './recovery';
export * from './finality';
export * from './forced-revert';
export * from './events';
export * from './watcher';
// G2: P2's passkey encoder. The generic byte helpers (bytesToHex, base64url, ...) are only on '@hogee/chain/passkey'.
export {
  P256_HALF_N,
  P256_N,
  PasskeyEncodingError,
  WEBAUTHN_AUTH_ABI,
  assertChallengeMatches,
  clientDataIndices,
  encodeWebAuthnAuth,
  normalizeLowS,
  parseDerSignature,
  publicKeyFromSpki,
  webAuthnSig,
  webAuthnSigData,
  type RawAssertion,
  type WebAuthnAuth,
} from './passkey';
