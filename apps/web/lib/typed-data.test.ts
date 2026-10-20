/**
 * The signing panel's checks (P1 review of #5): rows come from the signed message, and a request for another kind,
 * struct, deployment or an expired one is refused even when its digest is self-consistent.
 */
import { describe, expect, it } from "vitest";
import { catalogMilestoneRows, payoutAccountHash, webMilestoneRows, webPayoutRows, type SignatureRequestResponse, type TypedData, type WebOrderRow } from "@hogee/core";
import { chainTagOf, hogeeDomain, hogeeTypes, scheduleHash, toBytes32Tag } from "@hogee/api-mock/eip712";
import { bytesToBase64Url, hexToBytes, type Hex } from "./passkey-encode";
import { signedRows } from "./signed-rows";
import { checkSignatureRequest, digestOf, type SigningContext } from "./typed-data";

const CTX: SigningContext = { kind: "LoosenRequest", chainId: 11155111, deploymentId: "final-1" };
const NOW = Date.UTC(2026, 9, 17);
const CONTRACT = "0x00000000000000000000000000000000000000aa";
const ZERO = `0x${"0".repeat(64)}`;

function typedData(opts: { deploymentId?: string; message?: Record<string, string | boolean>; types?: TypedData["types"] } = {}): TypedData {
  const domain = hogeeDomain({ verifyingContract: CONTRACT, chainTag: toBytes32Tag(chainTagOf(CTX.chainId)), deploymentId: toBytes32Tag(opts.deploymentId ?? CTX.deploymentId) });
  return {
    domain,
    types: opts.types ?? { LoosenRequest: hogeeTypes.LoosenRequest.map((f) => ({ ...f })) },
    primaryType: "LoosenRequest",
    message: {
      kind: "1",
      target: toBytes32Tag("ADS"),
      aux: ZERO,
      newValue: "60000",
      deploymentId: toBytes32Tag(CTX.deploymentId),
      nonce: "7",
      expiry: String(NOW / 1000 + 900),
      ...opts.message,
    },
  };
}

/** A request whose digest, challenge and panel all agree with its typed data (what a hostile server would send). */
function request(td: TypedData, rows: SignatureRequestResponse["displayModel"]["rows"] = [{ label: "Change", value: "Raise the ADS cap a little", effect: "loosen" }]): SignatureRequestResponse {
  const digest = digestOf(td);
  return {
    requestId: "sig-1",
    typedData: td,
    digest,
    challengeB64url: bytesToBase64Url(hexToBytes(digest as Hex)),
    displayModel: {
      title: "Raise a cap",
      kind: td.primaryType,
      rows,
      digest,
      chainId: CTX.chainId,
      contract: CONTRACT,
      deploymentId: CTX.deploymentId,
    },
    expiresAt: String(td.message.expiry),
  };
}

const reason = (req: SignatureRequestResponse, ctx: SigningContext = CTX) => checkSignatureRequest(req, ctx, NOW).reason;

describe("signing request checks", () => {
  it("accepts the expected struct on this deployment and decodes the rows from the message", () => {
    const req = request(typedData());
    expect(checkSignatureRequest(req, CTX, NOW).ok).toBe(true);
    const rows = signedRows(req.typedData);
    expect(rows[0]).toMatchObject({ label: "Change", effect: "loosen" });
    expect(rows[0]?.value).toMatch(/^Raise the most-per-payment limit of the Ads pocket to 600(\.00)? BU$/);
    expect(rows.map((r) => r.value)).not.toContain("Raise the ADS cap a little");
  });

  it("shows the amount actually signed, whatever the server's text says", () => {
    const rows = signedRows(request(typedData({ message: { newValue: "99999999" } })).typedData);
    expect(rows[0]?.value).toContain("999,999.99");
  });

  it("refuses a request for a different kind than the user asked to sign", () => {
    expect(reason(request(typedData()), { ...CTX, kind: "PlanApproval" })).toMatch(/different kind of approval from the one you opened/);
  });

  it("refuses typed data that isn't the frozen struct, even with a matching digest", () => {
    const types = { LoosenRequest: hogeeTypes.LoosenRequest.map((f) => (f.name === "newValue" ? { name: "newValue", type: "uint128" } : { ...f })) };
    expect(reason(request(typedData({ types })))).toMatch(/isn't in the expected format/);
  });

  it("refuses a domain or message for another deployment", () => {
    expect(reason(request(typedData({ deploymentId: "other-1" })))).toMatch(/different blockchain or app version/);
    expect(reason(request(typedData({ message: { deploymentId: toBytes32Tag("other-1") } })))).toMatch(/for a different app version/);
  });

  it("refuses an expired request and an unknown change kind", () => {
    expect(reason(request(typedData({ message: { expiry: String(NOW / 1000 - 1) } })))).toMatch(/expired/);
    expect(reason(request(typedData({ message: { kind: "99" } })))).toMatch(/can't show this kind of change/);
  });

  it("refuses a digest that doesn't match the typed data", () => {
    const req = request(typedData());
    expect(reason({ ...req, digest: `0x${"1".repeat(64)}` })).toMatch(/code to sign doesn't match/);
  });
});

describe("a web supplier's SupplierApproval: account and milestones recomputed in the browser (run-9)", () => {
  const WEB: SigningContext = { ...CTX, kind: "SupplierApproval" };
  const HOLDER = "Yongkang Corvane Drinkware Co., Ltd.";
  const ACCOUNT = "0123456789";
  const SCHEDULE = [
    { trigger: "ON_ORDER", amountMinor: 75_000n, autoRelease: true },
    { trigger: "ON_DELIVERY_INSPECTED", amountMinor: 175_000n, autoRelease: false },
  ] as const;
  const shown = (over: { holderName?: string; accountNumber?: string; schedule?: readonly { amountMinor: bigint; autoRelease: boolean }[] } = {}): WebOrderRow[] => [
    { label: "Order", value: "order-wcorvanetest2-001", effect: "neutral" },
    ...webPayoutRows({ holderName: over.holderName ?? HOLDER, accountNumber: over.accountNumber ?? ACCOUNT, bankName: "Maybank" }),
    ...webMilestoneRows(over.schedule ?? SCHEDULE),
  ];
  const approval = (supplier = "supplier-wcorvanetest2", message: Record<string, string | boolean> = {}): TypedData => {
    const domain = hogeeDomain({ verifyingContract: CONTRACT, chainTag: toBytes32Tag(chainTagOf(CTX.chainId)), deploymentId: toBytes32Tag(CTX.deploymentId) });
    return {
      domain,
      types: { SupplierApproval: hogeeTypes.SupplierApproval.map((f) => ({ ...f })) },
      primaryType: "SupplierApproval",
      message: {
        orderId: toBytes32Tag("order-wcorvanetest2-001"),
        supplierId: toBytes32Tag(supplier),
        payee: toBytes32Tag(supplier),
        payoutAccountHash: payoutAccountHash({ channel: "MOCK_ONLY", accountNumber: ACCOUNT, holderName: HOLDER }),
        lineId: toBytes32Tag("SUPPLIER"),
        scheduleHash: scheduleHash([75_000n, 175_000n], [true, false]),
        totalMinor: "250000",
        quoteHash: `0x${"ab".repeat(32)}`,
        shortlistHash: `0x${"cd".repeat(32)}`,
        chosenIndex: "0",
        inspectionRequired: true,
        deploymentId: toBytes32Tag(CTX.deploymentId),
        nonce: "8",
        expiry: String(NOW / 1000 + 900),
        ...message,
      },
    };
  };
  const check = (req: SignatureRequestResponse) => checkSignatureRequest(req, WEB, NOW);

  it("shows the holder, the whole account number and every milestone as signed rows when they hash to the message", () => {
    const td = approval();
    const c = check(request(td, shown()));
    expect(c.ok).toBe(true);
    const rows = signedRows(td, c.webOrder);
    const value = (label: string) => rows.find((r) => r.label === label)?.value;
    expect(value("Paid to (name on the account)")).toBe(HOLDER);
    expect(value("Account number")).toBe("0123 4567 89");
    expect(value("Deposit (payment 1 of 2)")).toMatch(/^750 BU, paid automatically after the safety wait$/);
    expect(value("Balance (payment 2 of 2)")).toMatch(/^1,750 BU, paid only when you approve it, after a delivery check$/);
    expect(rows.map((r) => r.label)).not.toContain("Bank");
  });

  it("refuses to sign when the shown account or milestones are not what the message commits to", () => {
    const td = approval();
    expect(check(request(td, shown({ holderName: "Harbourline Cups Co., Ltd." }))).reason).toMatch(/bank account shown is not/);
    expect(check(request(td, shown({ accountNumber: "9123456789" }))).reason).toMatch(/bank account shown is not/);
    const moved = [
      { amountMinor: 80_000n, autoRelease: true },
      { amountMinor: 170_000n, autoRelease: false },
    ];
    expect(check(request(td, shown({ schedule: moved }))).reason).toMatch(/payments shown/);
    const flipped = [
      { amountMinor: 75_000n, autoRelease: false },
      { amountMinor: 175_000n, autoRelease: false },
    ];
    expect(check(request(td, shown({ schedule: flipped }))).reason).toMatch(/payments shown/);
    // A name that hashes to the message but does not render as it reads (bidi override) is refused too.
    const spoofed = "Corvane \u202eDTL OC";
    const spoofTd = approval(undefined, { payoutAccountHash: payoutAccountHash({ channel: "MOCK_ONLY", accountNumber: ACCOUNT, holderName: spoofed }) });
    expect(check(request(spoofTd, shown({ holderName: spoofed }))).reason).toMatch(/hidden characters/);
    const merged = shown().filter((r) => !["Account holder", "Bank"].includes(r.label));
    expect(check(request(td, merged)).reason).toMatch(/doesn't show the full account name/);
    expect(check(request(approval(undefined, { totalMinor: "250100" }), shown())).reason).toMatch(/order total/);
  });

  it("refuses, never throws, when the shown rows cannot even be hashed (re-check keccak LOW 2)", () => {
    // An amount past uint128/uint256: the abi encoding throws inside the check; the dialog must refuse, not crash.
    const huge = [{ amountMinor: 10n ** 90n, autoRelease: true }];
    const c = check(request(approval(), shown({ schedule: huge })));
    expect(c.ok).toBe(false);
    expect(c.reason).toMatch(/couldn't check the bank account or payments/);
  });

  // Re-check review LOW 2: a catalog order has no account rows to recompute, but its milestones are checked as well.
  const CATALOG = [
    { amountMinor: 30_000n, autoRelease: true },
    { amountMinor: 120_000n, autoRelease: true },
    { amountMinor: 280_000n, autoRelease: false },
  ];
  const catalogTd = (message: Record<string, string | boolean> = {}) =>
    approval("supplier-a", { scheduleHash: scheduleHash([30_000n, 120_000n, 280_000n], [true, true, false]), totalMinor: "430000", ...message });
  const catalogShown = (schedule: readonly { amountMinor: bigint; autoRelease: boolean }[] = CATALOG): WebOrderRow[] => [
    { label: "Order", value: "order-a-001", effect: "neutral" },
    ...catalogMilestoneRows(schedule),
  ];

  it("checks a catalog supplier's milestones against scheduleHash and totalMinor and shows them as signed rows", () => {
    const td = catalogTd();
    const c = check(request(td, catalogShown()));
    expect(c.ok).toBe(true);
    expect(c.webOrder).toBeUndefined();
    expect(c.schedule).toEqual(CATALOG);
    const rows = signedRows(td, c.webOrder, c.schedule);
    expect(rows.map((r) => r.label)).not.toContain("Paid to (name on the account)");
    expect(rows.find((r) => r.label === "Balance (payment 3 of 3)")?.value).toMatch(/^2,800 BU, paid only after a delivery check and your signature$/);
    expect(rows.map((r) => r.label)).toContain("Bank account (check code)");
  });

  it("refuses a catalog approval whose milestones are missing, differ from scheduleHash or do not add up", () => {
    expect(check(request(catalogTd(), [{ label: "Order", value: "order-a-001", effect: "neutral" }])).reason).toMatch(/doesn't show all the payments/);
    const [sample, deposit] = CATALOG as [(typeof CATALOG)[number], (typeof CATALOG)[number]];
    const moved = [sample, { amountMinor: 130_000n, autoRelease: true }, { amountMinor: 270_000n, autoRelease: false }];
    expect(check(request(catalogTd(), catalogShown(moved))).reason).toMatch(/payments shown/);
    const flipped = [sample, deposit, { amountMinor: 280_000n, autoRelease: true }];
    expect(check(request(catalogTd(), catalogShown(flipped))).reason).toMatch(/payments shown/);
    expect(check(request(catalogTd({ totalMinor: "430100" }), catalogShown())).reason).toMatch(/order total/);
    // The web wording on a catalog order is not the catalog's built form.
    expect(check(request(catalogTd(), [...webMilestoneRows(CATALOG)])).reason).toMatch(/doesn't show all the payments/);
  });
});
