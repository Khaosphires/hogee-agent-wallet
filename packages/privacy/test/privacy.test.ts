import { describe, expect, it } from "vitest";
import { PII_ENTITIES } from "@hogee/core";
import { MAX_CANARY_CHARS, MAX_REDACT_CHARS, PiiLeakError, PrivacyInputTooLargeError, assertNoIds, redact } from "../src/index";

// All identifiers below are synthetic (valid shape and checksum, no real person or account).
const MYKAD = "900101-14-5678";
const NIK = "3171010101900001";

describe("redact (task 3.11)", () => {
  it("redact replaces a synthetic MyKad with a placeholder and reports MY_NRIC with original offsets", async () => {
    const input = `Hi, my IC is ${MYKAD}. Thanks!`;
    const r = await redact(input);
    expect(r.text).toBe("Hi, my IC is <MY_NRIC>. Thanks!");
    expect(r.report).toEqual({ entities: [{ type: "MY_NRIC", start: 13, end: 27 }], count: 1 });
    expect(input.slice(13, 27)).toBe(MYKAD);
  });

  it("reports every span against the ORIGINAL text: sorted, non-overlapping, end exclusive", async () => {
    const input = `IC ${MYKAD}, NIK ${NIK}, call +60 12-345 6789, mail rina.tan@example.com, NRIC S1234567D, +65 9123 4567`;
    const r = await redact(input);
    expect(r.text).toBe("IC <MY_NRIC>, NIK <ID_NIK>, call <MY_PHONE>, mail <EMAIL_ADDRESS>, NRIC <SG_NRIC>, <SG_PHONE>");
    expect(r.report.count).toBe(6);
    expect(r.report.entities.map((s) => input.slice(s.start, s.end))).toEqual([MYKAD, NIK, "+60 12-345 6789", "rina.tan@example.com", "S1234567D", "+65 9123 4567"]);
    for (let i = 1; i < r.report.entities.length; i += 1) {
      expect(r.report.entities[i]!.start).toBeGreaterThanOrEqual(r.report.entities[i - 1]!.end);
    }
  });

  it("is deterministic: identical input gives identical output", async () => {
    const input = `call 9123 4567 or +62 812 3456 7890; card 4111 1111 1111 1111; IC ${MYKAD}`;
    const a = await redact(input);
    const b = await redact(input);
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("returns clean text unchanged with an empty report", async () => {
    for (const input of ["", "hello", "Budget SGD 10,000 for tumblers from Yiwu, launch on 2026-11-01."]) {
      expect(await redact(input)).toEqual({ text: input, report: { entities: [], count: 0 } });
    }
  });

  it("an overlapping shorter match is absorbed by the longer one (one span, no digit left visible)", async () => {
    // "+65 9123 4567" (international) contains "9123 4567" (local, context "call"): one span, the longer type.
    const r = await redact("call +65 9123 4567 today");
    expect(r.text).toBe("call <SG_PHONE> today");
    expect(r.report.entities).toEqual([{ type: "SG_PHONE", start: 5, end: 18 }]);
  });

  it("folds full-width and other Unicode digits, and zero-width characters cannot split an ID", async () => {
    const fullWidth = "ＩＣ ９００１０１－１４－５６７８";
    const r1 = await redact(fullWidth);
    expect(r1.text).toBe("ＩＣ <MY_NRIC>");
    expect(r1.report.entities).toEqual([{ type: "MY_NRIC", start: 3, end: 17 }]);
    const zw = "IC 9001\u200b01-14-56\u00ad78 ok";
    const r2 = await redact(zw);
    expect(r2.text).toBe("IC <MY_NRIC> ok");
    expect(zw.slice(r2.report.entities[0]!.start, r2.report.entities[0]!.end)).toBe("9001\u200b01-14-56\u00ad78");
    const arabic = "NIK ٣١٧١٠١٠١٠١٩٠٠٠٠١";
    expect((await redact(arabic)).text).toBe("NIK <ID_NIK>");
  });

  it("keeps offsets right around astral characters (surrogate pairs)", async () => {
    const input = `🙂🙂 IC ${MYKAD} 🙂`;
    const r = await redact(input);
    expect(r.text).toBe("🙂🙂 IC <MY_NRIC> 🙂");
    const s = r.report.entities[0]!;
    expect(input.slice(s.start, s.end)).toBe(MYKAD);
  });

  it("frozen entity names are the core PiiEntity values (E5 scores spans by these names)", async () => {
    const input = `IC ${MYKAD} NIK ${NIK} npwp 01.234.567.4-901.000 Maybank account 514123456789 call 012-345 6789 or 0812-3456-7890`;
    const types = (await redact(input)).report.entities.map((e) => e.type);
    expect(types).toEqual(["MY_NRIC", "ID_NIK", "ID_NPWP", "MY_BANK_ACCOUNT", "MY_PHONE", "ID_PHONE"]);
    for (const t of types) expect(PII_ENTITIES as readonly string[]).toContain(t);
  });
});

describe("redact fails closed", () => {
  it("rejects a non-string", async () => {
    await expect(redact(42 as unknown as string)).rejects.toBeInstanceOf(TypeError);
    await expect(redact(undefined as unknown as string)).rejects.toBeInstanceOf(TypeError);
  });

  it("refuses input above the size cap instead of scanning part of it", async () => {
    await expect(redact("a".repeat(MAX_REDACT_CHARS + 1))).rejects.toBeInstanceOf(PrivacyInputTooLargeError);
    await expect(redact("a".repeat(MAX_REDACT_CHARS))).resolves.toMatchObject({ report: { count: 0 } });
  });
});

describe("assertNoIds canary", () => {
  it("assertNoIds throws PiiLeakError for a synthetic NIK and passes clean text", () => {
    expect(() => assertNoIds(`my NIK is ${NIK}`)).toThrow(PiiLeakError);
    expect(() => assertNoIds("Plan v3: ADS 30000 minor, window 604800 s, order-a-001.")).not.toThrow();
  });

  it("names each leaked entity type once, sorted, and never echoes the identifier", () => {
    let err: unknown;
    try {
      assertNoIds(`S1234567D ${NIK} ${MYKAD} ${NIK} 01.234.567.4-901.000`);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PiiLeakError);
    expect((err as PiiLeakError).entities).toEqual(["ID_NIK", "ID_NPWP", "MY_NRIC", "SG_NRIC"]);
    for (const secret of [NIK, MYKAD, "S1234567D", "1234567"]) expect((err as Error).message).not.toContain(secret);
  });

  it("sees through JSON escapes in a serialised prompt (\\n, \\u0039, escaped quotes)", () => {
    expect(() => assertNoIds(JSON.stringify({ prompt: [{ role: "user", content: `IC:\n${MYKAD}` }] }))).toThrow(PiiLeakError);
    expect(() => assertNoIds('{"input":"\\u0039\\u0030\\u0030101-14-5678"}')).toThrow(PiiLeakError);
    expect(() => assertNoIds(JSON.stringify({ input: JSON.stringify({ nric: "T1234567J" }) }))).toThrow(PiiLeakError);
  });

  it("catches full-width digits and zero-width splitting", () => {
    expect(() => assertNoIds("９００１０１－１４－５６７８")).toThrow(PiiLeakError);
    expect(() => assertNoIds("S12345\u200b67D")).toThrow(PiiLeakError);
  });

  it("is about national and tax IDs only: phones, e-mails and cards are redact()'s job", () => {
    expect(() => assertNoIds("call +65 9123 4567 or rina.tan@example.com, card 4111 1111 1111 1111")).not.toThrow();
  });

  it("does not fire on invalid look-alikes (bad checksum, date or region)", () => {
    expect(() => assertNoIds("S1234567A 901301-14-5678 1071010101900001 900101-17-5678")).not.toThrow();
  });

  it("fails closed on a non-string or an over-size input", () => {
    expect(() => assertNoIds(null as unknown as string)).toThrow(TypeError);
    expect(() => assertNoIds("a".repeat(MAX_CANARY_CHARS + 1))).toThrow(PrivacyInputTooLargeError);
  });
});
