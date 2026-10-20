/**
 * SG-DECISIONS in the mock: Singapore (Mei) is the default demo, Malaysia (Rina) is served with HOGEE_COUNTRY=MY and
 * is the country-switch preview, Indonesia still previews. SG never shows Malaysia's names or rules.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { signPersonaCookie } from "@hogee/api";
import {
  MEI_IDS,
  PERSONA_COOKIE,
  RINA_IDS,
  examplePlanDraft,
  type Balances,
  type ChatMessage,
  type CountryCode,
  type Payment,
  type PlanDraft,
  type PlanRecord,
  type Session,
  type Shortlist,
  type TraceEvent,
} from "@hogee/core";
import { previewCountry } from "../src/country";
import { readEnv } from "../src/env";
import { getState } from "../src/store";
import { COUNTRY_RULES } from "../src/country-rules";
import { parseMockCountry } from "../src/profile";
import { findMyLabel } from "../src/scenario-mei";
import { harness, json, profile, secret } from "./support/harness";

beforeAll(() => {
  process.env.DEMO_MODE = "1";
  process.env.PERSONA_COOKIE_SECRET = secret();
  process.env.OFFICER_TOKEN = secret();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const { app } = await import("../src/index");
const { cookie, call } = harness(app);

const draftOf = async (): Promise<PlanDraft> => (await call<PlanDraft>("/api/plans/draft", json({ sessionId: profile().sessionId }))).body;
const preview = (draftId: string, country: CountryCode) => call<PlanDraft>("/api/plans/preview-country", json({ draftId, country }));
const ruleIds = (d: PlanDraft): string[] => d.manifest.rules.map((r) => r.ruleId);
const ruleText = (d: PlanDraft): string => d.manifest.rules.map((r) => r.text).join(" ");
const MY_WORDS = /Rina|Malaysia|MYR|RM ?\d|SSM|LHDN|SST|MyInvois/;
const SG_WORDS = /Mei\b|Singapore|SGD|S\$|ACRA|GST|IRAS|InvoiceNow|SFA/;

/** What the founder's screens read, in one object (the label check walks it all). */
async function everything(): Promise<unknown> {
  await call("/api/demo/reset", json({}), "officer");
  const shortlistId = getState(readEnv()).loaded.scenario["shortlist.json"].requestId;
  return {
    session: (await call<Session>("/api/session")).body,
    draft: await draftOf(),
    plan: (await call<PlanRecord>("/api/plans/current")).body,
    shortlist: (await call<Shortlist>(`/api/suppliers/shortlist/${shortlistId}`)).body,
    supplier: (await call("/api/suppliers/supplier-a")).body,
    escrow: (await call(`/api/escrow/${MEI_IDS.supplierAOrderId}`)).body,
    balances: (await call<Balances>("/api/balances")).body,
    payments: (await call<Payment[]>("/api/payments")).body,
    traces: (await call<TraceEvent[]>("/api/traces")).body,
    exceptions: (await call("/api/exceptions")).body,
    chat: (await call<ChatMessage[]>(`/api/chat/${profile().sessionId}`)).body,
  };
}

describe("Singapore (Mei) is the default demo", () => {
  it("serves Mei: founder persona, ids, SGD facility, SG plan", async () => {
    expect(profile().country).toBe("SG");
    const session = (await call<Session>("/api/session")).body;
    expect(session).toMatchObject({ persona: "founder:mei", founderId: MEI_IDS.founderId, facilityId: MEI_IDS.facilityId });
    const plan = (await call<PlanRecord>("/api/plans/current")).body;
    expect([plan.manifest.countryCode, plan.manifest.displayCurrency, plan.manifest.facilityId]).toEqual(["SG", "SGD", MEI_IDS.facilityId]);
    const draft = await draftOf();
    expect([draft.intent.countryCode, draft.intent.entityType]).toEqual(["SG", "sg_sole_prop"]);
    expect((await call<{ orderId: string | null }>("/api/suppliers/supplier-a")).body.orderId).toBe(MEI_IDS.supplierAOrderId);
  });

  it("Mei's plan shows the free SFA importer registration (1 product, SGD 0.00) with the compiler's wording", async () => {
    const draft = await draftOf();
    const sfa = draft.manifest.rules.find((r) => r.ruleId === "approval.sfa.fee.0");
    expect(sfa).toMatchObject({ text: "Product approval: SFA, fee SGD 0.00 for 1 product.", sourceRef: "/productApprovals/drinkware_food_contact/cost" });
    expect(sfa?.source).toMatchObject({ sourceType: "mock", evidence: "tier3" });
    expect(ruleIds(draft)).toEqual(expect.arrayContaining(["registration.acra_business.fee.11500", "indirect-tax.not-registered", "einvoicing.not-required", "duty.mfn", "import-tax.rate"]));
    expect(ruleIds(draft)).not.toContain("approval.none");
  });

  it("shows no Malaysian name, label or payee anywhere a founder looks", async () => {
    const all = await everything();
    expect(findMyLabel(all)).toBeUndefined();
    expect(JSON.stringify(all)).not.toMatch(/lhdn-tax|printer-kl|shopee-ads|spx-logistics|founder:rina|fac-rina/);
  });

  it("chats as Mei in Singapore and S$, never Rina, Malaysian or RM10,000", async () => {
    const sessionId = "01a14202-2800-7000-8000-00000000beef";
    const turns: string[] = [];
    for (const message of ["I want to sell custom insulated tumblers", "citizen", "drinkware"]) {
      const res = await app.request("/api/chat", { ...json({ sessionId, message }), headers: { "content-type": "application/json", cookie: await cookie("founder") } });
      turns.push(await res.text());
    }
    const all = turns.join("\n");
    expect(turns[0]).toContain("Mei");
    expect(turns[0]).toContain("Singapore citizen");
    expect(turns[2]).toContain("S$10,000");
    expect(turns[2]).toContain("loan in SGD");
    expect(all).not.toMatch(/Rina|Malaysian|RM10,000|MYR/);
  });

  it("labels Mei's payouts as Sample PayNow payouts (no real bank transfer), in payment rows and traces", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-17T00:00:00Z"));
    await call("/api/demo/reset", json({}), "officer");
    const seeded = (await call<Payment[]>("/api/payments")).body.filter((p) => p.payout.payoutId);
    expect(seeded.length).toBeGreaterThan(0);
    expect(seeded.every((p) => p.payout.payoutId?.startsWith("simulated-paynow-"))).toBe(true);
    const proposed = await call<{ paymentId?: string }>("/api/proposals/spend", json({ lineKey: "ADS", pacingSlot: 41, reason: "Daily ads slot" }));
    vi.setSystemTime(new Date("2026-10-17T00:00:07Z"));
    const paid = (await call<Payment & { traces: TraceEvent[] }>(`/api/payments/${proposed.body.paymentId}`)).body;
    expect(paid.state).toBe("SETTLED");
    expect(paid.payeeId).toBe(MEI_IDS.adsPayeeId);
    expect(paid.payout.payoutId).toMatch(/^simulated-paynow-/);
    const payout = paid.traces.find((t) => t.kind === "PAYOUT");
    expect(payout?.summary).toMatch(/^Sample payout \(PayNow\)/);
    expect(payout?.summary).toContain("no real bank transfer");
    expect(JSON.stringify(paid)).not.toMatch(/Test-mode|Xendit/);
  });

  it("names Mei on the passkey it asks Mei to create", async () => {
    await call("/api/demo/reset", json({}), "officer");
    const { body: issued } = await call<{ code: string }>("/api/officer/founder-key/enrolment-code", json({}), "officer");
    const { body } = await call<{ user: { name: string; displayName: string } }>("/api/passkey/register/options", json({ enrolmentCode: issued.code }));
    expect(body.user).toMatchObject({ name: "mei", displayName: "Mei" });
  });

  it("sends the reserve only to iras-tax (lhdn-tax is refused)", async () => {
    const ask = (taxPayeeId: string) => call<{ status?: string; error?: { message: string } }>("/api/exceptions", json({ kind: "WITHDRAW_RESERVE", payload: { taxPayeeId, amountMinor: "100" }, reason: "GST" }));
    await call("/api/demo/reset", json({}), "officer");
    await call("/api/demo/sale", json({ amountMinor: "50000" }), "officer");
    const lhdn = await ask(RINA_IDS.taxPayeeId);
    expect(lhdn.status).toBe(422);
    expect(lhdn.body.error?.message).toContain("iras-tax");
    expect((await ask(MEI_IDS.taxPayeeId)).body.status).toBe("OPEN");
  });
});

describe("persona per country (SG-DECISIONS Q1)", () => {
  const mint = (persona: string) => app.request("/api/session/persona", json({ persona }));
  const signed = (persona: "founder:rina" | "founder:mei") =>
    `${PERSONA_COOKIE}=${signPersonaCookie(persona, { secret: process.env.PERSONA_COOKIE_SECRET ?? "", now: Date.now() })}`;
  const sessionWith = async (cookieLine: string) => (await (await app.request("/api/session", { headers: { cookie: cookieLine } })).json()) as Session;

  it("SG mints only founder:mei; founder:rina is refused with no cookie", async () => {
    const res = await mint("founder:rina");
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${PERSONA_COOKIE}=`))).toBe(false);
    expect((await mint("founder:mei")).status).toBe(200);
  });

  it("SG reads a valid founder:rina cookie, or none, as founder:mei; the officer stays the officer", async () => {
    expect((await sessionWith(signed("founder:rina"))).persona).toBe("founder:mei");
    expect((await sessionWith("")).persona).toBe("founder:mei");
    expect((await call<Session>("/api/session", {}, "officer")).body.persona).toBe("officer");
  });

  it("MY is the mirror image: founder:rina only, and a founder:mei cookie reads as Rina", async () => {
    vi.stubEnv("HOGEE_COUNTRY", "MY");
    expect((await mint("founder:mei")).status).toBe(403);
    expect((await sessionWith(signed("founder:mei"))).persona).toBe("founder:rina");
    expect((await call<Session>("/api/session")).body).toMatchObject({ persona: "founder:rina", founderId: RINA_IDS.founderId });
  });
});

describe("country-switch preview: exhaustive, one country's rules each", () => {
  it("SG → MY shows Malaysia's rules and names, and no SG rule", async () => {
    const base = await draftOf();
    const my = (await preview(base.draftId, "MY")).body;
    expect(my.draftId).toBe(`${base.draftId}-my`);
    expect([my.intent.countryCode, my.intent.entityType, my.manifest.countryCode]).toEqual(["MY", "sole_prop", "MY"]);
    expect(ruleIds(my)).toEqual(expect.arrayContaining(["registration.ssm_sole_prop.fee.6000", "approval.none", "duty.form_e"]));
    expect(ruleIds(my)).not.toContain("approval.sfa.fee.0");
    expect(my.manifest.rules[0]?.text).toMatch(/SSM|MYR/);
    expect(ruleText(my)).not.toMatch(/GST|ACRA|SFA|InvoiceNow|SGD/);
    // The constitution and the compiler's own rules hold in both countries.
    expect(ruleIds(my)).toEqual(expect.arrayContaining(["constitution.caps", "stage.gate"]));
  });

  it("back to SG returns the base draft; ID still previews; another country fails closed", async () => {
    const base = await draftOf();
    expect((await preview(`${base.draftId}-my`, "SG")).body).toEqual(base);
    const id = (await preview(base.draftId, "ID")).body;
    expect([id.draftId, id.intent.entityType]).toEqual([`${base.draftId}-id`, "perorangan"]);
    expect(id.manifest.rules[0]?.text).toMatch(/NIK|Indonesia|Rp/);
    expect(ruleText(id)).not.toMatch(SG_WORDS);
    expect(() => previewCountry(base, "TH" as CountryCode)).toThrow(/no country rules for "TH"/);
    expect(() => previewCountry(base, "__proto__" as CountryCode)).toThrow();
  });

  it("every preview country carries its own rules only", () => {
    for (const [country, rules] of Object.entries(COUNTRY_RULES)) {
      const draft = previewCountry({ ...examplePlanDraft, intent: { ...examplePlanDraft.intent, countryCode: country === "ID" ? "MY" : "ID" } }, country as CountryCode);
      expect(draft.manifest.countryCode).toBe(country);
      expect(draft.manifest.rules.slice(0, rules.rules.length)).toEqual(rules.rules);
    }
    expect(ruleText(previewCountry(examplePlanDraft, "SG"))).not.toMatch(MY_WORDS);
  });

  it("with HOGEE_COUNTRY=MY (Rina), MY → SG shows Singapore's rules and the SFA step, nothing Malaysian", async () => {
    vi.stubEnv("HOGEE_COUNTRY", "MY");
    const base = await draftOf();
    expect(base.intent.countryCode).toBe("MY");
    const sg = (await preview(base.draftId, "SG")).body;
    expect([sg.intent.entityType, sg.manifest.countryCode]).toEqual(["sg_sole_prop", "SG"]);
    expect(ruleIds(sg)).toContain("approval.sfa.fee.0");
    expect(findMyLabel(sg.manifest.rules)).toBeUndefined();
  });
});

describe("Malaysia (Rina) with HOGEE_COUNTRY=MY", () => {
  it("serves Rina's scenario, chat, payees and Xendit test-mode payouts as before", async () => {
    vi.stubEnv("HOGEE_COUNTRY", "MY");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-17T00:00:00Z"));
    await call("/api/demo/reset", json({}), "officer");
    expect((await call<{ currency?: string; facilityId: string }>("/api/session")).body.facilityId).toBe(RINA_IDS.facilityId);
    const plan = (await call<PlanRecord>("/api/plans/current")).body;
    expect([plan.manifest.countryCode, plan.manifest.displayCurrency]).toEqual(["MY", "MYR"]);
    const res = await app.request("/api/chat", { ...json({ sessionId: "01a14202-2800-7000-8000-00000000f00d", message: "Hi" }), headers: { "content-type": "application/json", cookie: await cookie("founder") } });
    await res.text();
    const history = (await call<ChatMessage[]>("/api/chat/01a14202-2800-7000-8000-00000000f00d")).body;
    expect(JSON.stringify(history.at(-1))).toContain("Thanks, Rina.");
    const proposed = await call<{ paymentId?: string }>("/api/proposals/spend", json({ lineKey: "ADS", pacingSlot: 42, reason: "Daily ads slot" }));
    vi.setSystemTime(new Date("2026-10-17T00:00:07Z"));
    const paid = (await call<Payment & { traces: TraceEvent[] }>(`/api/payments/${proposed.body.paymentId}`)).body;
    expect(paid.payeeId).toBe(RINA_IDS.adsPayeeId);
    expect(paid.traces.find((t) => t.kind === "PAYOUT")?.summary).toBe("Test-mode payout succeeded; settlement confirmed on-chain");
    expect((await call<{ orderId: string | null }>("/api/suppliers/supplier-a")).body.orderId).toBe(RINA_IDS.supplierAOrderId);
  });

  it("sends Rina's reserve only to lhdn-tax", async () => {
    vi.stubEnv("HOGEE_COUNTRY", "MY");
    await call("/api/demo/reset", json({}), "officer");
    await call("/api/demo/sale", json({ amountMinor: "50000" }), "officer");
    const ask = (taxPayeeId: string) => call<{ status?: string }>("/api/exceptions", json({ kind: "WITHDRAW_RESERVE", payload: { taxPayeeId, amountMinor: "100" }, reason: "SST" }));
    expect((await ask(MEI_IDS.taxPayeeId)).status).toBe(422);
    expect((await ask(RINA_IDS.taxPayeeId)).body.status).toBe("OPEN");
  });
});

describe("HOGEE_COUNTRY fails closed", () => {
  it("accepts SG (default) and MY only", () => {
    expect(parseMockCountry(undefined)).toBe("SG");
    expect(parseMockCountry(" MY ")).toBe("MY");
    for (const bad of ["ID", "TH", "sg", "SG,MY"]) expect(() => parseMockCountry(bad), bad).toThrow(/HOGEE_COUNTRY/);
  });

  it("answers every request 502 for a country the mock has no founder for, never another country's data", async () => {
    vi.stubEnv("HOGEE_COUNTRY", "ID");
    const res = await app.request("/api/session");
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toMatch(/founder|fac-/);
  });
});
