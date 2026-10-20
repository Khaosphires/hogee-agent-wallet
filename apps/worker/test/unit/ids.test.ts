import { DecisionId } from '@hogee/core';
import { describe, expect, it } from 'vitest';
import { uuidv7 } from '../../src/runtime/ids';

describe('uuidv7', () => {
  it('is a lowercase UUIDv7 that core accepts as a decisionId', () => {
    const ms = Date.UTC(2026, 9, 17);
    const id = uuidv7(ms);
    expect(DecisionId.parse(id)).toBe(id);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id.replace('-', '').slice(0, 12)).toBe(ms.toString(16).padStart(12, '0'));
  });

  it('sorts by time and does not repeat', () => {
    const a = uuidv7(1_000);
    const b = uuidv7(2_000);
    expect(a < b).toBe(true);
    expect(new Set(Array.from({ length: 200 }, () => uuidv7())).size).toBe(200);
  });
});
