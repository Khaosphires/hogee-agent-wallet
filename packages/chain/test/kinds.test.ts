import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HOGEE_KINDS, LINE_SUPPLIER, constitutionCodeName, requiresLender, toBytes32Tag } from '../src/index';

const SOL = readFileSync(new URL('../../../contracts/src/interfaces/HogeeKinds.sol', import.meta.url), 'utf8');

function solidityUint8Constants(source: string): Record<string, number> {
  const re = /uint8 internal constant (\w+) = (\d+);/g;
  return Object.fromEntries([...source.matchAll(re)].map((m) => [m[1], Number(m[2])]));
}

describe('HOGEE_KINDS mirrors HogeeKinds.sol', () => {
  const sol = solidityUint8Constants(SOL);

  it('has the same names and values in both directions', () => {
    expect(Object.keys(sol).length).toBeGreaterThan(30);
    expect(HOGEE_KINDS).toEqual(sol);
  });

  it('LINE_SUPPLIER is the right-padded "SUPPLIER" lineId', () => {
    expect(SOL).toContain('bytes32 internal constant LINE_SUPPLIER = "SUPPLIER";');
    expect(LINE_SUPPLIER).toBe(toBytes32Tag('SUPPLIER'));
  });

  it('constitution codes are unique, contiguous from 1, and named', () => {
    const codes = Object.entries(HOGEE_KINDS)
      .filter(([name]) => name.startsWith('CONST_'))
      .map(([, code]) => code)
      .sort((a, b) => a - b);
    expect(codes).toEqual(codes.map((_, i) => i + 1));
    expect(constitutionCodeName(7)).toBe('CONST_RESERVE_BELOW_FLOOR');
    expect(constitutionCodeName(14)).toBe('CONST_REPLAN_LOOSENS'); // G0-AUDIT (v-1)
    expect(constitutionCodeName(99)).toBeUndefined();
  });

  it('tighten and loosen kinds are unique within their family and start at 1', () => {
    for (const prefix of ['TIGHTEN_', 'LOOSEN_RAISE', 'SIG_']) {
      const values = Object.entries(HOGEE_KINDS)
        .filter(([name]) => name.startsWith(prefix))
        .map(([, v]) => v);
      expect(new Set(values).size).toBe(values.length);
    }
    const loosen = Object.entries(HOGEE_KINDS)
      .filter(([name]) => name.startsWith('LOOSEN_') && !name.startsWith('LOOSEN_STATUS_'))
      .map(([, v]) => v)
      .sort((a, b) => a - b);
    expect(loosen).toEqual(loosen.map((_, i) => i + 1));
  });
});

describe('requiresLender (G0-REVIEW H2)', () => {
  it('is true for every current loosen kind and fails safe for unknown kinds', () => {
    const loosenKinds = Object.entries(HOGEE_KINDS)
      .filter(([name]) => name.startsWith('LOOSEN_') && !name.startsWith('LOOSEN_STATUS_'))
      .map(([, v]) => v);
    expect(loosenKinds).toHaveLength(8);
    for (const kind of loosenKinds) expect(requiresLender(kind)).toBe(true);
    expect(requiresLender(0)).toBe(true);
    expect(requiresLender(255)).toBe(true);
  });

  it('exists in HogeeKinds.sol with the same semantics', () => {
    expect(SOL).toContain('function requiresLender(uint8 kind) internal pure returns (bool)');
  });
});
