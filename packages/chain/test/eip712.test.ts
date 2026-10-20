import { describe, expect, it } from 'vitest';
import {
  encodeAbiParameters,
  hashStruct,
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  toHex,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  HOGEE_STRUCT_NAMES,
  HOGEE_TYPEHASHES,
  HOGEE_TYPE_STRINGS,
  VERIFYING_CONTRACT_OF,
  hashHogeeTypedData,
  hashLines,
  hashLoosenRequest,
  hashMilestoneRelease,
  hashOwnerSpend,
  hashPlanApproval,
  hashStageRelease,
  hashStages,
  hashSupplierApproval,
  hogeeDomain,
  hogeeDomainSalt,
  hogeeDomainSeparator,
  hogeeTypedData,
  hogeeTypes,
  intentId,
  loosenId,
  manifestToLines,
  manifestToStages,
  milestoneSettlementId,
  scheduleHash,
  toBytes32Tag,
  utf8Keccak,
  type HogeeMessages,
  type HogeeStructName,
} from '../src/index';
import * as rina from './fixtures/rina';

/**
 * Golden values. The SAME constants are asserted in contracts/test/HogeeTypes.t.sol, so Solidity and viem
 * agree byte for byte. If a struct changes, regenerate with `forge test --match-test test_printGoldenValues -vv`
 * and update both files. G0-REVIEW (M15): ShortId fixture ids, payoutAccountHash, lines/stages from the manifest.
 */
const GOLDEN = {
  salt: '0xad2cf874712553c65a450322ecd5a8d900f5996d2fa7624cb6e05668b21a793c',
  domainPlanRegistry: '0x365a0a5b776039b83db0c0ef7371264aecf3c2a039679bdfba84e78376ce60dd',
  domainTreasury: '0xab00f13d53fa343cd9e9cd41cd2edc10c79ae022a2114b63c54f5f1aa675e583',
  domainEscrow: '0x37c2c93b67aaa67013d81d04c22d146a6e03de68ba34a59d61301c3b43191f98',
  linesHash: '0xf107f98a529a7babf40d18450be14ad9a7d9be6c882bb6611b43de466b217b7f',
  stagesHash: '0x229235b75cedf075cfab4a7f865757c64ccd87de48f1f98feb38b64bb024acc5',
  scheduleHash: '0xfea3a9bb8d64835cd5740fcb968598cea369fe43fe8b3bd67efcf2cda1b83e69',
  payoutAccountHash: '0x142ad066e84bde38bc37aadb3976a708f96b660bb1bed323a05cbf7c42191ccc',
  digest: {
    PlanApproval: '0xc74fa2a0af3ae20fb8f15e3a27954f26f64cc22779f5ba03ada026b801a41cb3',
    SupplierApproval: '0xf3c90db36bafd47db3d31119da579aebcd43c8724d1e69bc9a7b431927094875',
    MilestoneRelease: '0x2a322e076faa2d58edc0e1cf5cae4cd369c9bcd555622e3462ba87014c448dff',
    LoosenRequest: '0x4d69b63a7f2af0bf050fb4d70b0ef6841628ed5929da7cd3d8da768f85412413',
    StageRelease: '0x70334df2c0429d708921a10829d15a261f37cbba1cea1efeab9b329271743ea2',
    OwnerSpend: '0x43948dc926605ec391b015c6e558d28808062904fcaf8380563a41cc687b1d1a',
  },
  loosenId: '0x7bee358064686cb5a144cfaf3c85196442266401c9ccd433cb17a84b7e72afc5',
  intentId: '0x5c14ef8802a3b69ac9f5ad728717d9d3adf7c6f729e79f35f4eb7bf751ee9bfd',
  milestoneSettlementId: '0x04e6c326322fd125ad3a52cff712548a8afbb63c23e9d5917dba83e213ed9888',
} as const;

const domainArgs = { chainTag: rina.CHAIN_TAG, deploymentId: rina.DEPLOYMENT_ID };
const domains = {
  PlanRegistry: hogeeDomain({ verifyingContract: rina.PLAN_REGISTRY, ...domainArgs }),
  Treasury: hogeeDomain({ verifyingContract: rina.TREASURY, ...domainArgs }),
  MilestoneEscrow: hogeeDomain({ verifyingContract: rina.ESCROW, ...domainArgs }),
};

const messages: HogeeMessages = {
  PlanApproval: rina.planApproval,
  SupplierApproval: rina.supplierApproval,
  MilestoneRelease: rina.milestoneRelease,
  LoosenRequest: rina.loosenRequest,
  StageRelease: rina.stageRelease,
  OwnerSpend: rina.ownerSpend,
};

const domainOf = (name: HogeeStructName) => domains[VERIFYING_CONTRACT_OF[name]];

describe('type strings and typehashes', () => {
  it.each(Object.keys(HOGEE_TYPE_STRINGS) as (keyof typeof HOGEE_TYPE_STRINGS)[])(
    '%s TYPEHASH = keccak256(type string)',
    (name) => {
      expect(keccak256(toHex(HOGEE_TYPE_STRINGS[name]))).toBe(HOGEE_TYPEHASHES[name]);
    },
  );

  it.each(HOGEE_STRUCT_NAMES)('%s: viem hashStruct uses exactly our type string', (name) => {
    const fields = hogeeTypes[name];
    const message = messages[name] as unknown as Record<string, unknown>;
    const manual = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, ...fields.map((f) => ({ type: f.type }))],
        [HOGEE_TYPEHASHES[name], ...fields.map((f) => message[f.name])],
      ),
    );
    expect(hashStruct({ data: messages[name], primaryType: name, types: hogeeTypes })).toBe(manual);
  });
});

describe('domain', () => {
  it('salt = keccak256(abi.encode(chainTag, deploymentId))', () => {
    expect(hogeeDomainSalt(rina.CHAIN_TAG, rina.DEPLOYMENT_ID)).toBe(GOLDEN.salt);
  });

  it('has no chainId and matches the golden separators', () => {
    expect(Object.keys(domains.PlanRegistry).sort()).toEqual(['name', 'salt', 'verifyingContract', 'version']);
    expect(hogeeDomainSeparator(domains.PlanRegistry)).toBe(GOLDEN.domainPlanRegistry);
    expect(hogeeDomainSeparator(domains.Treasury)).toBe(GOLDEN.domainTreasury);
    expect(hogeeDomainSeparator(domains.MilestoneEscrow)).toBe(GOLDEN.domainEscrow);
  });

  it('changes with chainTag and deploymentId (T28 replay guard)', () => {
    const other = (chainTag: string, deploymentId: string) =>
      hogeeDomainSeparator(
        hogeeDomain({
          verifyingContract: rina.PLAN_REGISTRY,
          chainTag: toBytes32Tag(chainTag),
          deploymentId: toBytes32Tag(deploymentId),
        }),
      );
    expect(other('fisco', 'final-1')).not.toBe(GOLDEN.domainPlanRegistry);
    expect(other('sepolia', 'loop-1')).not.toBe(GOLDEN.domainPlanRegistry);
  });

  it('rejects malformed bytes32 inputs and over-long tags', () => {
    expect(() => hogeeDomainSalt('0x1234', rina.DEPLOYMENT_ID)).toThrow(/chainTag/);
    expect(() => toBytes32Tag('')).toThrow();
    expect(() => toBytes32Tag('x'.repeat(33))).toThrow(/too long/);
  });
});

describe('golden commitments (Rina, §26.2)', () => {
  it('linesHash and stagesHash from the Rina PlanManifest (manifestToLines / manifestToStages)', () => {
    expect(hashLines(manifestToLines(rina.rinaManifest))).toBe(GOLDEN.linesHash);
    expect(hashStages(manifestToStages(rina.rinaManifest))).toBe(GOLDEN.stagesHash);
    expect(rina.planApproval.linesHash).toBe(GOLDEN.linesHash);
    expect(rina.planApproval.stagesHash).toBe(GOLDEN.stagesHash);
  });

  it('scheduleHash and payoutAccountHash', () => {
    expect(utf8Keccak(rina.SUPPLIER_A_ACCOUNT_JCS)).toBe(GOLDEN.payoutAccountHash);
    expect(rina.supplierApproval.payoutAccountHash).toBe(GOLDEN.payoutAccountHash);
    expect(scheduleHash(rina.schedule, rina.autoRelease)).toBe(GOLDEN.scheduleHash);
    expect(() => scheduleHash([1n], [])).toThrow(/lengths differ/);
  });

  it('intentId, milestone settlementId and loosenId', () => {
    const invoiceHash = encodeAbiParameters([{ type: 'uint256' }], [1n]);
    expect(
      intentId({
        planId: rina.PLAN_ID,
        lineId: toBytes32Tag('ADS'),
        payeeId: toBytes32Tag('shopee-ads'),
        invoiceHash,
        amountMinor: 10_000n,
      }),
    ).toBe(GOLDEN.intentId);
    expect(milestoneSettlementId(rina.ORDER_A, 2)).toBe(GOLDEN.milestoneSettlementId);
    expect(loosenId(rina.loosenRequest)).toBe(GOLDEN.loosenId);
  });
});

describe('golden digests', () => {
  it('PlanApproval (Rina v1) matches the Solidity digest', () => {
    expect(hashPlanApproval(domains.PlanRegistry, rina.planApproval)).toBe(GOLDEN.digest.PlanApproval);
  });

  it('every other struct matches the Solidity digest', () => {
    expect(hashSupplierApproval(domains.Treasury, rina.supplierApproval)).toBe(GOLDEN.digest.SupplierApproval);
    expect(hashMilestoneRelease(domains.MilestoneEscrow, rina.milestoneRelease)).toBe(GOLDEN.digest.MilestoneRelease);
    expect(hashLoosenRequest(domains.Treasury, rina.loosenRequest)).toBe(GOLDEN.digest.LoosenRequest);
    expect(hashStageRelease(domains.Treasury, rina.stageRelease)).toBe(GOLDEN.digest.StageRelease);
    expect(hashOwnerSpend(domains.Treasury, rina.ownerSpend)).toBe(GOLDEN.digest.OwnerSpend);
  });

  it.each(HOGEE_STRUCT_NAMES)('%s: generic helper and wallet payload give the same digest', (name) => {
    const domain = domainOf(name);
    const message = messages[name];
    const typed = hogeeTypedData(name, domain, message);
    expect(hashHogeeTypedData(name, domain, message)).toBe(GOLDEN.digest[name]);
    // `name` is a union here, so viem cannot narrow the payload; the concrete case is type-checked below.
    expect(hashTypedData(typed as unknown as Parameters<typeof hashTypedData>[0])).toBe(GOLDEN.digest[name]);
    expect(Object.keys(typed.types)).toEqual([name]);
  });

  it('an ECDSA signature over the typed data recovers the signer', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const typed = hogeeTypedData('PlanApproval', domains.PlanRegistry, rina.planApproval);
    const signature: Hex = await account.signTypedData(typed);
    const recovered = await recoverTypedDataAddress({ ...typed, signature });
    expect(recovered).toBe(account.address);
  });
});
