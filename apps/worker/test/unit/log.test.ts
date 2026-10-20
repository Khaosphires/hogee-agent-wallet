import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/runtime/log';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const log = createLogger({ sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>), base: { svc: 'worker' } });
  return { log, lines };
}

describe('createLogger', () => {
  it('writes one JSON line per event with level, event and fields', () => {
    const { log, lines } = capture();
    log.info('tick_done', { block: 12n, facilityId: 'fac-rina' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'info', event: 'tick_done', block: '12', facilityId: 'fac-rina', svc: 'worker' });
    expect(typeof lines[0]?.ts).toBe('string');
  });

  it('redacts URLs and errors (provider keys hide in them)', () => {
    const { log, lines } = capture();
    log.error('rpc_failed', { error: new Error('request to https://eth.example/v2/s3cret failed'), note: 'see https://x.example/k' });
    const text = JSON.stringify(lines[0]);
    expect(text).not.toContain('s3cret');
    expect(text).not.toContain('x.example/k');
    expect(lines[0]?.error).toMatch(/^Error: request to <url> failed/);
  });

  it('drops any field whose name looks like a secret', () => {
    const { log, lines } = capture();
    log.warn('oops', { privateKey: 'abc', apiKey: 'def', password: 'ghi', mnemonic: 'jkl', databaseUrl: 'postgres://u:p@h/db' });
    const text = JSON.stringify(lines[0]);
    for (const secret of ['abc', 'def', 'ghi', 'jkl', 'u:p@h']) expect(text).not.toContain(secret);
  });

  it('keeps ordinary fields that merely end in "key" (lineKey, singletonKey)', () => {
    const { log, lines } = capture();
    log.info('pacing_skip', { lineKey: 'ADS', idempotencyKeyHash: '0x12' });
    expect(lines[0]).toMatchObject({ lineKey: 'ADS' });
  });

  it('child loggers add fields', () => {
    const { log, lines } = capture();
    log.child({ job: 'reconcile' }).info('pass');
    expect(lines[0]).toMatchObject({ job: 'reconcile', svc: 'worker', event: 'pass' });
  });
});
