import { describe, expect, it } from "vitest";
import { PiiLeakError, assertNoIds, isSgNric, redact } from "../src/index";

// Table tests per entity: valid (redacted), invalid checksum / date / region (kept), and in context.
// Every value is synthetic: a valid shape and check digit, not a real person, phone or account.

type Row = readonly [input: string, expected: string];

async function check(rows: readonly Row[]) {
  for (const [input, expected] of rows) expect((await redact(input)).text, input).toBe(expected);
}

describe("MY_NRIC (MyKad YYMMDD-PB-###G)", () => {
  it("valid: separated or plain, any real date and an issued place-of-birth code", () =>
    check([
      ["900101-14-5678", "<MY_NRIC>"],
      ["IC: 880229 10 1234", "IC: <MY_NRIC>"],
      ["no. kp 900101145678", "no. kp <MY_NRIC>"],
      ["(900101-99-5678)", "(<MY_NRIC>)"],
    ]));
  it("invalid: impossible date or never-issued place-of-birth code", () =>
    check([
      ["901301-14-5678", "901301-14-5678"],
      ["900230-14-5678", "900230-14-5678"],
      ["870229-10-1234", "870229-10-1234"],
      ["900101-00-5678", "900101-00-5678"],
      ["900101-17-5678", "900101-17-5678"],
      ["900101-70-5678", "900101-70-5678"],
      ["901301145678", "901301145678"],
    ]));
  it("glued to letters or digits it is part of another word, not an IC", () =>
    check([
      ["X900101-14-5678", "X900101-14-5678"],
      ["9900101-14-5678", "9900101-14-5678"],
    ]));
});

describe("ID_NIK (16 digits: province, regency, district, birth date, serial)", () => {
  it("valid: men and women (day + 40), plain or grouped 6-6-4", () =>
    check([
      ["NIK 3171010101900001", "NIK <ID_NIK>"],
      ["3171014101900002", "<ID_NIK>"],
      ["KTP 317101 010190 0001", "KTP <ID_NIK>"],
      ["9601017001000123", "<ID_NIK>"],
    ]));
  it("invalid: unknown province, zero regency, impossible date, zero serial", () =>
    check([
      ["1071010101900001", "1071010101900001"],
      ["3100010101900001", "3100010101900001"],
      ["3171013201900001", "3171013201900001"],
      ["3171013002900001", "3171013002900001"],
      ["3171010113900001", "3171010113900001"],
      ["3171010101900000", "3171010101900000"],
    ]));
});

describe("ID_NPWP", () => {
  it("valid: the dotted format needs no context; bare digits need an NPWP context word", () =>
    check([
      ["01.234.567.4-901.000", "<ID_NPWP>"],
      ["NPWP: 012345674901000", "NPWP: <ID_NPWP>"],
      ["npwp 0012345674901000", "npwp <ID_NPWP>"],
    ]));
  it("bare 15 digits without context are not an NPWP", () => check([["ref 012345674901000", "ref 012345674901000"]]));

  // Check digit: Luhn over the first 9 digits (python-stdnum id.npwp, Perl Business::ID::NPWP; docs/decisions/privacy.md).
  it("check digit: valid dotted and bare forms are redacted", () =>
    check([
      ["09.876.543.1-210.000", "<ID_NPWP>"],
      ["03.111.222.0-054.001", "<ID_NPWP>"],
      ["NPWP 076543214012000", "NPWP <ID_NPWP>"],
      ["NPWP16 0020000014091000", "NPWP16 <ID_NPWP>"],
      ["npwp 3171010101900001", "npwp <ID_NPWP>"],
    ]));
  it("check digit: a wrong 9th digit is kept, dotted or bare, and the canary lets it pass", async () => {
    await check([
      ["09.876.543.2-210.000", "09.876.543.2-210.000"],
      ["01.234.567.8-901.000", "01.234.567.8-901.000"],
      ["NPWP 076543215012000", "NPWP 076543215012000"],
      ["NPWP16 0020000015091000", "NPWP16 0020000015091000"],
      ["npwp 1234567890123456", "npwp 1234567890123456"],
    ]);
    expect(() => assertNoIds("09.876.543.2-210.000")).not.toThrow();
    expect(() => assertNoIds("09.876.543.1-210.000")).toThrow(PiiLeakError);
  });
});

describe("ID_NIK written 4-4-4-4", () => {
  it("with spaces or dashes it is redacted, and the canary blocks it", async () => {
    await check([
      ["NIK 3171 0101 0190 0001", "NIK <ID_NIK>"],
      ["3171-0141-0190-0002", "<ID_NIK>"],
      ["KTP: 3171 0101-0190 0001.", "KTP: <ID_NIK>."],
    ]);
    for (const s of ["3171 0101 0190 0001", "no KTP 3171-0141-0190-0002", JSON.stringify({ note: "NIK:\n3171 0101 0190 0001" })]) {
      expect(() => assertNoIds(s), s).toThrow(PiiLeakError);
    }
  });
  it("an invalid NIK in 4-4-4-4 is kept and passes the canary", async () => {
    await check([
      ["1071 0101 0190 0001", "1071 0101 0190 0001"],
      ["3171-0132-0190-0001", "3171-0132-0190-0001"],
    ]);
    expect(() => assertNoIds("1071 0101 0190 0001")).not.toThrow();
  });
});

describe("ID_PHONE landline with a bracketed area code", () => {
  it("(0XX) / (0XXX) numbers are redacted with the brackets, no context needed", () =>
    check([
      ["(021) 1234 5678", "<ID_PHONE>"],
      ["Kantor: (021) 1234-5678.", "Kantor: <ID_PHONE>."],
      ["(0274) 123456", "<ID_PHONE>"],
      ["(0361)765432", "<ID_PHONE>"],
    ]));
  it("not an Indonesian area code, or too short, is kept", () =>
    check([
      // "(03) 1234 5678" and "(082) 123 456" are Malaysian landlines now (MY_PHONE bracketed pattern); "(01)" and
      // "(081)" are area codes in neither country.
      ["(01) 1234 5678", "(01) 1234 5678"],
      ["(081) 123 456", "(081) 123 456"],
      ["(021) 12", "(021) 12"],
    ]));
});

describe("veto words are whole words (only $-style symbols may touch the digits)", () => {
  it("a veto word inside a longer word does not veto: Buddy is not bu, Capital is not cap", () =>
    check([
      ["客户：陈慧敏（新加坡 Brew Buddy）\n联系电话：+65 94509005", "客户：陈慧敏（新加坡 Brew Buddy）\n联系电话：<SG_PHONE>"],
      ["Maybank Capital 514123456789", "Maybank Capital <MY_BANK_ACCOUNT>"],
      ["card feedback 4111111111111111", "card feedback <CREDIT_CARD>"],
    ]));
  it("a whole veto word, or a currency symbol glued to the digits, still vetoes an ambiguous number", () =>
    check([
      ["card total $4222222222222", "card total $4222222222222"],
      ["visa S$4222222222222", "visa S$4222222222222"],
      ["call me, budget 91234567", "call me, budget 91234567"],
    ]));
});

// Security audit run-8 (detect.ts candidatesOf): a money word anywhere in the 12 characters before a number used to
// veto every pattern, so "budget SGD 500, call +65 9123 4567" reached the model provider unredacted.
describe("veto words never suppress a number that is unambiguous on its own", () => {
  it("a phone written with its country code (+65 / +60 / +62, 00-style or bracketed) is redacted after any money word", () =>
    check([
      ["budget SGD 500, call +65 9123 4567", "budget SGD 500, call <SG_PHONE>"],
      ["budget SGD 5, call +65 9123 4567", "budget SGD 5, call <SG_PHONE>"],
      ["price S$12 +65 91234567", "price S$12 <SG_PHONE>"],
      ["Budget S$8k, HP +65 9123 4567", "Budget S$8k, HP <SG_PHONE>"],
      ["My budget, tel +65 9123 4567", "My budget, tel <SG_PHONE>"],
      ["budget: +65 9123 4567", "budget: <SG_PHONE>"],
      ["fee 0065 9123 4567", "fee <SG_PHONE>"],
      ["S$ (65) 6123-4567", "S$ <SG_PHONE>"],
      ["RM 500, +60 12-345 6789", "RM 500, <MY_PHONE>"],
      ["RM +60 3-1234 5678", "RM <MY_PHONE>"],
      ["Rp 50.000, +62 812 3456 7890", "Rp 50.000, <ID_PHONE>"],
      ["harga 0062 812 3456 7890", "harga <ID_PHONE>"],
    ]));
  // P1, 18 Oct: an amount never starts with 0, so the national mobile forms and a bracketed area code are exempt too.
  it("a MY 01X or ID 08XX mobile, or an ID landline with its area code in brackets, is redacted after any money word", () =>
    check([
      ["RM 012-345 6789", "RM <MY_PHONE>"],
      ["RM 0123456789", "RM <MY_PHONE>"],
      ["budget: 011-2345 6789", "budget: <MY_PHONE>"],
      ["Rp 0812 3456 7890", "Rp <ID_PHONE>"],
      ["harga 081234567890", "harga <ID_PHONE>"],
      ["harga (021) 1234 5678", "harga <ID_PHONE>"],
      ["fee: (0274) 123456", "fee: <ID_PHONE>"],
    ]));
  it("a Luhn-valid 15- or 16-digit card is redacted after any money word, even one glued to it", () =>
    check([
      ["fee: 4111 1111 1111 1111", "fee: <CREDIT_CARD>"],
      ["Fee $5, card 4111 1111 1111 1111", "Fee $5, card <CREDIT_CARD>"],
      ["RM 4111111111111111", "RM <CREDIT_CARD>"],
      ["card total $4111111111111111", "card total $<CREDIT_CARD>"],
      ["visa S$4111111111111111", "visa S$<CREDIT_CARD>"],
      ["amount 3782 822463 10005", "amount <CREDIT_CARD>"],
      ["price: 5555-5555-5555-4444", "price: <CREDIT_CARD>"],
    ]));
});

describe("for an ambiguous bare number, only a money word directly before it vetoes", () => {
  it("separated by nothing but spaces, a colon or a currency symbol, the money word vetoes", () =>
    check([
      ["SGD 91234567", "SGD 91234567"],
      ["call me, SGD 91234567", "call me, SGD 91234567"],
      ["whatsapp budget: 9123 4567", "whatsapp budget: 9123 4567"],
      ["call, budget S$ 9123 4567", "call, budget S$ 9123 4567"],
      ["call, cap ¥ 91234567", "call, cap ¥ 91234567"],
      ["tel RM 03-1234 5678", "tel RM 03-1234 5678"],
      ["telp Rp 021-1234 5678", "telp Rp 021-1234 5678"],
      ["total: $4222222222222", "total: $4222222222222"],
      ["account balance RM 5141234567", "account balance RM 5141234567"],
    ]));
  it("a money word further back in the window, with anything else in between, does not veto", () =>
    check([
      ["Budget SGD 500, call 9123 4567", "Budget SGD 500, call <SG_PHONE>"],
      ["S$12 phone 91234567", "S$12 phone <SG_PHONE>"],
      ["Bajet RM 10k, tel 012-345 6789", "Bajet RM 10k, tel <MY_PHONE>"],
      ["fee 5, hp 0812-3456-7890", "fee 5, hp <ID_PHONE>"],
      ["total for 4222222222222", "total for <CREDIT_CARD>"],
      ["CIMB a/c, fee waived 8001234567", "CIMB a/c, fee waived <MY_BANK_ACCOUNT>"],
    ]));
  it("a money word more than negative_before (12) characters back does not veto, even across spaces only", () =>
    check([[`call, budget${" ".repeat(12)}91234567`, `call, budget${" ".repeat(12)}<SG_PHONE>`]]));
});

describe("MY_BANK_ACCOUNT context window: 48 characters earlier on the same line", () => {
  it("a bank word up to 48 characters before the number counts", () =>
    check([
      ["Maybank, branch Jalan Tun Razak, no. 514123456789", "Maybank, branch Jalan Tun Razak, no. <MY_BANK_ACCOUNT>"],
      [`account ${"x".repeat(30)} 514123456789`, `account ${"x".repeat(30)} <MY_BANK_ACCOUNT>`],
    ]));
  it("a bank word on the previous line, or further than 48 characters, does not", () =>
    check([
      ["Maybank\n514123456789", "Maybank\n514123456789"],
      [`account ${"x".repeat(45)} 514123456789`, `account ${"x".repeat(45)} 514123456789`],
    ]));
});

describe("MY_BANK_ACCOUNT (needs a bank or account word nearby)", () => {
  it("in context: plain or grouped", () =>
    check([
      ["Maybank account 514123456789", "Maybank account <MY_BANK_ACCOUNT>"],
      ["CIMB a/c 8001-2345-67", "CIMB a/c <MY_BANK_ACCOUNT>"],
      ["no. akaun 1122 3344 5566", "no. akaun <MY_BANK_ACCOUNT>"],
    ]));
  it("without context, as an amount, or a placeholder run it is kept", () =>
    check([
      ["514123456789", "514123456789"],
      ["account balance RM 5141234567", "account balance RM 5141234567"],
      ["bank account 0000000000", "bank account 0000000000"],
    ]));
});

describe("MY_PHONE", () => {
  it("valid: +60 any, 01X mobile without context, landline with context", () =>
    check([
      ["+60 12-345 6789", "<MY_PHONE>"],
      ["+60123456789", "<MY_PHONE>"],
      ["012-345 6789", "<MY_PHONE>"],
      ["011-2345 6789", "<MY_PHONE>"],
      ["+60 3-1234 5678", "<MY_PHONE>"],
      ["tel 03-1234 5678", "tel <MY_PHONE>"],
    ]));
  it("invalid or context-less landline is kept", () =>
    check([
      ["03-1234 5678", "03-1234 5678"],
      ["012-345 678", "012-345 678"],
    ]));
  it("a landline is redacted after the same new phone words as SG (number, no., ph, mob, telegram, duitnow)", () =>
    check([
      ["office number 03-1234 5678", "office number <MY_PHONE>"],
      ["nombor 04-261 2345", "nombor <MY_PHONE>"],
      ["no. 07-123 4567", "no. <MY_PHONE>"],
      ["DuitNow 03-1234 5678", "DuitNow <MY_PHONE>"],
    ]));
  it("a landline with its area code in brackets needs no context: (03) + 8 digits, (04)-(07)/(09) + 7, (082)-(089) + 6", () =>
    check([
      ["(03) 1234 5678", "<MY_PHONE>"],
      ["Tel: (082) 291 796", "Tel: <MY_PHONE>"],
      ["(04) 261 2345", "<MY_PHONE>"],
      ["(088)660920", "<MY_PHONE>"],
      ["Pejabat (03)-2123 4567.", "Pejabat <MY_PHONE>."],
      ["fee (09) 765 4321", "fee <MY_PHONE>"],
    ]));
  it("a bracketed code that is not a MY area code, or the wrong length after it, is kept", () =>
    check([
      ["(03) 1234 567", "(03) 1234 567"],
      ["(04) 1234 5678", "(04) 1234 5678"],
      ["(081) 291 796", "(081) 291 796"],
      ["(082) 291 7960", "(082) 291 7960"],
      ["(08) 1234 5678", "(08) 1234 5678"],
    ]));
});

describe("ID_PHONE", () => {
  it("valid: +62 any, 08XX mobile without context, landline with context", () =>
    check([
      ["+62 812 3456 7890", "<ID_PHONE>"],
      ["0812-3456-7890", "<ID_PHONE>"],
      ["081234567890", "<ID_PHONE>"],
      ["telp 021-1234 5678", "telp <ID_PHONE>"],
    ]));
  it("too short is kept", () => check([["0812 345", "0812 345"]]));
  it("a landline is redacted after the same new phone words as SG (number, nomor, no., ph, mob, telegram)", () =>
    check([
      ["nomor 021-1234 5678", "nomor <ID_PHONE>"],
      ["No. 0274 123 456", "No. <ID_PHONE>"],
      ["office number 021-1234 5678", "office number <ID_PHONE>"],
    ]));
});

describe("SG_NRIC (NRIC/FIN, ICA check letter)", () => {
  it("valid for every series: S/T, F/G and M; lower case too", () =>
    check([
      ["NRIC S1234567D", "NRIC <SG_NRIC>"],
      ["T1234567J", "<SG_NRIC>"],
      ["FIN F1234567N", "FIN <SG_NRIC>"],
      ["G1234567X", "<SG_NRIC>"],
      ["M1234567K", "<SG_NRIC>"],
      ["s1234567d", "<SG_NRIC>"],
    ]));
  it("invalid check letter is kept", () =>
    check([
      ["S1234567A", "S1234567A"],
      ["F1234567D", "F1234567D"],
      ["M1234567L", "M1234567L"],
      ["T1234567D", "T1234567D"],
    ]));

  // One synthetic number per remainder 0..10, so every position of every table is exercised.
  const VECTORS: Record<string, readonly string[]> = {
    S: ["S1000013J", "S1000005Z", "S1000000I", "S1000006H", "S1000001G", "S1000007F", "S1000002E", "S1000008D", "S1000003C", "S1000009B", "S1000004A"],
    T: ["T1000008J", "T1000003Z", "T1000009I", "T1000004H", "T1000013G", "T1000005F", "T1000000E", "T1000006D", "T1000001C", "T1000007B", "T1000002A"],
    F: ["F1000013X", "F1000005W", "F1000000U", "F1000006T", "F1000001R", "F1000007Q", "F1000002P", "F1000008N", "F1000003M", "F1000009L", "F1000004K"],
    G: ["G1000008X", "G1000003W", "G1000009U", "G1000004T", "G1000013R", "G1000005Q", "G1000000P", "G1000006N", "G1000001M", "G1000007L", "G1000002K"],
    M: ["M1000003X", "M1000009W", "M1000004U", "M1000013T", "M1000005R", "M1000000Q", "M1000006P", "M1000001N", "M1000007J", "M1000002L", "M1000008K"],
  };

  it("every table position of S, T, F, G and M: the right letter is redacted, each of the 25 wrong ones is kept", async () => {
    for (const [prefix, ids] of Object.entries(VECTORS)) {
      expect(ids, prefix).toHaveLength(11);
      for (const id of ids) {
        expect(isSgNric(id), id).toBe(true);
        expect((await redact(`FIN ${id}`)).text, id).toBe("FIN <SG_NRIC>");
        for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
          if (letter === id.charAt(8)) continue;
          const wrong = id.slice(0, 8) + letter;
          expect(isSgNric(wrong), wrong).toBe(false);
        }
      }
    }
    expect((await redact("M1000007M")).text).toBe("M1000007M");
  });

  /**
   * Reference: GovTech FormSG, packages/shared/utils/nric-validation.ts (opengovsg/FormSG@6aa8c46), written in its own
   * shape so it checks validators.ts rather than repeating it. M: S1 = 3 + weighted sum, R1 = S1 % 11, P = 11 - R1,
   * letter = "KLJNPQRTUWX"[P - 1]. ICA does not publish the algorithm; samliew/singapore-nric@275f8a6 and
   * ionbazan/go-nric@bba1349 agree.
   */
  function formSgLetter(prefix: string, digits: string): string {
    const weighted = [2, 7, 6, 5, 4, 3, 2].reduce((acc, w, i) => acc + w * Number(digits.charAt(i)), 0);
    if (prefix === "M") return "KLJNPQRTUWX".charAt(11 - ((weighted + 3) % 11) - 1);
    const start = prefix === "S" || prefix === "F" ? 0 : 4;
    return (prefix === "S" || prefix === "T" ? "JZIHGFEDCBA" : "XWUTRQPNMLK").charAt((weighted + start) % 11);
  }

  it("agrees with GovTech FormSG's validator on 5,000 synthetic numbers per series", () => {
    let seed = 65;
    for (const prefix of ["S", "T", "F", "G", "M"]) {
      for (let i = 0; i < 5000; i += 1) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        const digits = String(seed % 10_000_000).padStart(7, "0");
        const expected = formSgLetter(prefix, digits);
        expect(isSgNric(`${prefix}${digits}${expected}`), `${prefix}${digits}${expected}`).toBe(true);
        const other = expected === "A" ? "B" : "A";
        expect(isSgNric(`${prefix}${digits}${other}`)).toBe(false);
      }
    }
  });
});

describe("SG_PHONE (8 digits starting 3, 6, 8 or 9; optional +65)", () => {
  it("+65 needs no context; a bare number needs a phone word", () =>
    check([
      ["+65 9123 4567", "<SG_PHONE>"],
      ["+6581234567", "<SG_PHONE>"],
      ["(65) 6123-4567", "<SG_PHONE>"],
      ["WhatsApp 9123 4567", "WhatsApp <SG_PHONE>"],
      ["call me at 31234567", "call me at <SG_PHONE>"],
      ["电话 8123 4567", "电话 <SG_PHONE>"],
    ]));
  // Security audit run-8 hunter notes: PayNow numbers are phone numbers, and "number" / "ph" / "mob" / "telegram" label them.
  it("a bare number after PayNow, number, no., ph, mob or telegram is a phone", () =>
    check([
      ["PayNow 9123 4567", "PayNow <SG_PHONE>"],
      ["pay via paynow to 81234567 pls", "pay via paynow to <SG_PHONE> pls"],
      ["my number is 9123 4567", "my number is <SG_PHONE>"],
      ["Rina's no. 6123 4567", "Rina's no. <SG_PHONE>"],
      ["ph: 9123 4567", "ph: <SG_PHONE>"],
      ["Mob 8123-4567", "Mob <SG_PHONE>"],
      ["Telegram @ 9123 4567", "Telegram @ <SG_PHONE>"],
    ]));
  it("the new words count only as whole words", () =>
    check([
      ["numbers 9123 4567", "numbers 9123 4567"],
      ["graph 9123 4567", "graph 9123 4567"],
      ["casino. 9123 4567", "casino. 9123 4567"],
      ["mobility 9123 4567", "mobility 9123 4567"],
    ]));
  it("wrong first digit, wrong length, or no context is kept", () =>
    check([
      ["+65 5123 4567", "+65 5123 4567"],
      ["+65 9123 456", "+65 9123 456"],
      ["9123 4567", "9123 4567"],
      ["phone 7123 4567", "phone 7123 4567"],
    ]));
});

describe("EMAIL_ADDRESS", () => {
  it("valid addresses", () =>
    check([
      ["rina.tan@example.com", "<EMAIL_ADDRESS>"],
      ["mail a+b@mail.example.co.uk.", "mail <EMAIL_ADDRESS>."],
    ]));
  it("package versions and scoped names are not e-mail", () =>
    check([
      ["react@18.3.1", "react@18.3.1"],
      ["@hogee/core", "@hogee/core"],
      ["user@-bad.com", "user@-bad.com"],
    ]));
});

describe("CREDIT_CARD (issuer prefix + Luhn)", () => {
  it("valid: grouped or plain, Visa / Mastercard / Amex / Discover / JCB", () =>
    check([
      ["4111 1111 1111 1111", "<CREDIT_CARD>"],
      ["card 4111111111111111", "card <CREDIT_CARD>"],
      ["5555-5555-5555-4444", "<CREDIT_CARD>"],
      ["2223003122003222", "<CREDIT_CARD>"],
      ["3782 822463 10005", "<CREDIT_CARD>"],
      ["6011111111111117", "<CREDIT_CARD>"],
      ["3530111333300000", "<CREDIT_CARD>"],
    ]));
  it("failed Luhn, unknown issuer, or an amount is kept", () =>
    check([
      ["4111 1111 1111 1112", "4111 1111 1111 1112"],
      ["1234567890123452", "1234567890123452"],
      ["RM 4222222222222", "RM 4222222222222"],
    ]));
});
