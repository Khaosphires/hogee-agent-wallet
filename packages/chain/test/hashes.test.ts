import { describe, expect, it } from 'vitest';
import { HOGEE_KINDS, manifestToLines, manifestToStages, toBytes32Tag, type ManifestInput } from '../src/index';
import { rinaManifest } from './fixtures/rina';

type Line = ManifestInput['lines'][number];
const ads = rinaManifest.lines[3] as Line;
const withLine = (patch: Partial<Line>): Pick<ManifestInput, 'lines'> => ({ lines: [{ ...ads, ...patch }] });

describe('manifestToLines (G0-REVIEW M15)', () => {
  it('maps digit strings to bigints, ShortIds to bytes32 and pacing to pacingMinor', () => {
    const [supplier, , , adsLine] = manifestToLines(rinaManifest);
    expect(adsLine).toEqual({
      lineId: toBytes32Tag('ADS'),
      amountMinor: 120_000n,
      perTxCapMinor: 30_000n,
      windowCapMinor: 60_000n,
      windowSeconds: 604_800,
      validUntil: 1_797_292_800n,
      pacingMinor: 7_500n,
      escrowOnly: false,
      payeeIds: [toBytes32Tag('shopee-ads')],
    });
    expect(supplier?.pacingMinor).toBe(0n);
    expect(supplier?.escrowOnly).toBe(true);
  });

  it.each([
    ['a lineId that does not match the lineKey', { lineId: toBytes32Tag('LOGISTICS') }, /lineId must equal/],
    ['a non-digit amount', { amountMinor: '12.5' }, /amountMinor must be a digit string/],
    ['a leading-zero amount', { amountMinor: '0100' }, /digit string/],
    ['a windowSeconds above uint32', { windowSeconds: String(2 ** 32) }, /windowSeconds is out of range/],
    ['a non-ShortId payee', { payeeIds: ['Shopee Ads'] }, /payeeIds\[0\] must be a ShortId/],
  ])('rejects %s', (_name, patch, message) => {
    expect(() => manifestToLines(withLine(patch))).toThrow(message);
  });
});

describe('manifestToStages (G0-REVIEW M15)', () => {
  it('maps a null gate to METRIC_NONE and salesMinor to METRIC_SALES_MINOR', () => {
    expect(manifestToStages(rinaManifest)).toEqual([
      { stageId: toBytes32Tag('stage-1'), releaseMinor: 400_000n, metric: HOGEE_KINDS.METRIC_NONE, target: 0n, deadline: 0n },
      {
        stageId: toBytes32Tag('stage-2'),
        releaseMinor: 600_000n,
        metric: HOGEE_KINDS.METRIC_SALES_MINOR,
        target: 200_000n,
        deadline: 1_794_700_800n,
      },
    ]);
  });

  it('maps the orders metric and rejects non-ShortId stage ids', () => {
    const gate = { metric: 'orders' as const, target: '25', deadline: '1794700800' };
    expect(manifestToStages({ stages: [{ stageId: 'stage-3', releaseMinor: '1', gate }] })[0]?.metric).toBe(
      HOGEE_KINDS.METRIC_ORDERS,
    );
    expect(() => manifestToStages({ stages: [{ stageId: 'STAGE_1', releaseMinor: '1', gate: null }] })).toThrow(
      /stageId must be a ShortId/,
    );
  });
});
