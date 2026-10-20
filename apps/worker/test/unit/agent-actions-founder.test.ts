import { toBytes32Tag } from '@hogee/chain';
import { decodeAbiParameters, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  FounderRelayRefusal,
  founderSigOf,
  milestoneReleaseMismatch,
  ownerSpendMismatch,
  passkeySigData,
  WEBAUTHN_AUTH_PARAMS,
} from '../../src/jobs/agent-actions-founder-sig';

const hex32 = (c: string): Hex => `0x${c.repeat(64)}` as Hex;

const passkey = {
  credentialId: 'Y3JlZA',
  r: hex32('1'),
  s: `0x${'0'.repeat(62)}05` as Hex,
  challengeIndex: 23,
  typeIndex: 1,
  authenticatorData: `0x${'49'.repeat(32)}0500000001` as Hex,
  clientDataJSON: '{"type":"webauthn.get","challenge":"abc","origin":"http://localhost"}',
};

describe('founderSigOf', () => {
  it('an ECDSA submit body becomes Sig kind 0 with the 65-byte signature', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const signature = await account.signMessage({ message: 'x' });
    expect(founderSigOf({ ecdsa: { signature } })).toEqual({ kind: 0, data: signature.toLowerCase() });
    // The stored body is the API-validated one (core SignatureSubmitBody): anything else is refused, not repaired.
    expect(() => founderSigOf({ ecdsa: { signature: signature.toUpperCase().replace('0X', '0x') } })).toThrow(FounderRelayRefusal);
  });

  it('a passkey assertion becomes Sig kind 1 = abi.encode(WebAuthnAuth)', () => {
    const sig = founderSigOf({ passkey });
    expect(sig.kind).toBe(1);
    expect(sig.data).toBe(passkeySigData(passkey));
    const [auth] = decodeAbiParameters(WEBAUTHN_AUTH_PARAMS, sig.data);
    expect(auth).toEqual({
      r: passkey.r,
      s: passkey.s,
      challengeIndex: 23n,
      typeIndex: 1n,
      authenticatorData: passkey.authenticatorData,
      clientDataJSON: passkey.clientDataJSON,
    });
  });

  it('refuses anything else (no signature, both kinds, a malformed or high-s signature)', () => {
    for (const bad of [null, {}, { ecdsa: { signature: '0x12' } }, { passkey: { ...passkey, s: hex32('f') } }, { ecdsa: { signature: `0x${'1'.repeat(130)}` }, passkey }]) {
      expect(() => founderSigOf(bad)).toThrow(FounderRelayRefusal);
    }
  });
});

const DEPLOYMENT = 'final-test';
const ownerMsg = {
  lineId: toBytes32Tag('LOGISTICS'),
  payeeId: toBytes32Tag('spx-logistics'),
  amountMinor: 4_000n,
  invoiceHash: hex32('9'),
  deploymentId: toBytes32Tag(DEPLOYMENT),
  nonce: 7n,
  expiry: 1_900_000_000n,
};
const ownerRow = { lineId: toBytes32Tag('LOGISTICS'), payeeId: 'spx-logistics', amountMinor: '4000', invoiceHash: hex32('9'), deploymentId: DEPLOYMENT };

describe('ownerSpendMismatch', () => {
  it('accepts exactly the signed struct and names the first field that differs', () => {
    expect(ownerSpendMismatch(ownerMsg, ownerRow)).toBeNull();
    expect(ownerSpendMismatch(ownerMsg, { ...ownerRow, amountMinor: '9000' })).toBe('amountMinor');
    expect(ownerSpendMismatch(ownerMsg, { ...ownerRow, payeeId: 'shopee-ads' })).toBe('payeeId');
    expect(ownerSpendMismatch(ownerMsg, { ...ownerRow, lineId: toBytes32Tag('ADS') })).toBe('lineId');
    expect(ownerSpendMismatch(ownerMsg, { ...ownerRow, invoiceHash: hex32('8') })).toBe('invoiceHash');
    expect(ownerSpendMismatch(ownerMsg, { ...ownerRow, deploymentId: 'other' })).toBe('deploymentId');
  });
});

describe('milestoneReleaseMismatch', () => {
  const msg = { orderId: toBytes32Tag('order-a-001'), idx: 2, amountMinor: 280_000n, evidenceHash: hex32('e'), deploymentId: toBytes32Tag(DEPLOYMENT), nonce: 1n, expiry: 1n };
  const row = { orderId: 'order-a-001', idx: 2, amountMinor: '280000', evidenceHash: hex32('e'), deploymentId: DEPLOYMENT };
  it('checks order, idx, amount, the stored inspection evidence and the deployment', () => {
    expect(milestoneReleaseMismatch(msg, row)).toBeNull();
    expect(milestoneReleaseMismatch(msg, { ...row, orderId: 'order-b-001' })).toBe('orderId');
    expect(milestoneReleaseMismatch(msg, { ...row, idx: 1 })).toBe('idx');
    expect(milestoneReleaseMismatch(msg, { ...row, amountMinor: '1' })).toBe('amountMinor');
    expect(milestoneReleaseMismatch(msg, { ...row, evidenceHash: hex32('f') })).toBe('evidenceHash');
    expect(milestoneReleaseMismatch(msg, { ...row, deploymentId: 'x' })).toBe('deploymentId');
  });
});
