import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { keyEnvName, keySetForDeployment, loadSigners, SIGNER_ROLES, SignerConfigError } from '../../src/config/keys';

function keyEnv(set: 'LOOP' | 'FINAL'): Record<string, string> {
  return Object.fromEntries(SIGNER_ROLES.map((role) => [keyEnvName(role, set), generatePrivateKey()]));
}

describe('keySetForDeployment', () => {
  it('maps loop-* to LOOP and final-* to FINAL', () => {
    expect(keySetForDeployment('loop-1')).toBe('LOOP');
    expect(keySetForDeployment('final-1')).toBe('FINAL');
    expect(() => keySetForDeployment('other-1')).toThrow(SignerConfigError);
  });
});

describe('loadSigners', () => {
  it('reads the four role keys of one set', () => {
    const env = keyEnv('LOOP');
    const signers = loadSigners(env, 'LOOP');
    expect(signers.set).toBe('LOOP');
    expect(signers.agent.address).toBe(privateKeyToAccount(env.AGENT_PRIVATE_KEY_LOOP as `0x${string}`).address);
    expect(signers.oracle.address).toBe(privateKeyToAccount(env.ORACLE_PRIVATE_KEY_LOOP as `0x${string}`).address);
  });

  it('names the missing or malformed variable, never its value', () => {
    const env = keyEnv('LOOP');
    delete env.ORACLE_PRIVATE_KEY_LOOP;
    expect(() => loadSigners(env, 'LOOP')).toThrow(/ORACLE_PRIVATE_KEY_LOOP/);
    const bad = { ...keyEnv('LOOP'), LENDER_PRIVATE_KEY_LOOP: '0x1234' };
    try {
      loadSigners(bad, 'LOOP');
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toMatch(/LENDER_PRIVATE_KEY_LOOP/);
      expect(String(error)).not.toContain('0x1234');
    }
  });

  it.each([
    ['zero', `0x${'0'.repeat(64)}`],
    ['the curve order n', '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'],
    ['above n', `0x${'f'.repeat(64)}`],
  ])('wraps a 64-hex key outside the secp256k1 range (%s) in SignerConfigError naming only the variable', (_label, value) => {
    // The other set is read too (the overlap check), so its keys are checked the same way.
    for (const name of ['AGENT_PRIVATE_KEY_LOOP', 'ORACLE_PRIVATE_KEY_FINAL']) {
      const env = { ...keyEnv('LOOP'), [name]: value };
      try {
        loadSigners(env, 'LOOP');
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(SignerConfigError);
        const text = `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack ?? ''} ${String((error as Error).cause ?? '')}`;
        expect(text).toContain(name);
        expect(text).not.toContain(value.slice(2, 40));
        expect((error as Error).cause).toBeUndefined();
      }
    }
  });

  it('refuses one key in two roles', () => {
    const env = keyEnv('LOOP');
    env.RELAYER_PRIVATE_KEY_LOOP = env.AGENT_PRIVATE_KEY_LOOP as string;
    expect(() => loadSigners(env, 'LOOP')).toThrow(/distinct/);
  });

  it('refuses a key shared by loop-1 and final-1 (separate key sets)', () => {
    const env = { ...keyEnv('LOOP'), ...keyEnv('FINAL') };
    env.ORACLE_PRIVATE_KEY_FINAL = env.ORACLE_PRIVATE_KEY_LOOP as string;
    expect(() => loadSigners(env, 'LOOP')).toThrow(/separate/);
  });

  it('scrubs both key sets from the env it read when asked', () => {
    const env: Record<string, string | undefined> = { ...keyEnv('LOOP'), ...keyEnv('FINAL'), OTHER: 'kept' };
    loadSigners(env, 'LOOP', { scrub: true });
    expect(Object.keys(env)).toEqual(['OTHER']);
  });

  it('never serialises a key', () => {
    const env = keyEnv('LOOP');
    const json = JSON.stringify(loadSigners(env, 'LOOP'));
    for (const value of Object.values(env)) expect(json).not.toContain(value.slice(2));
  });
});
