/** The profile saved on this device (UX round 2): parse with fallback, validation, and what is written. */
import { describe, expect, it } from "vitest";
import {
  PROFILE_MAX_STORED,
  defaultProfile,
  countryOf,
  fieldError,
  firstNameOf,
  initialsOf,
  parseStoredProfile,
  serializeProfile,
  type Profile,
} from "./profile";

const MEI = defaultProfile("founder:mei");
const edited: Profile = {
  displayName: "Mei Lin Tan",
  avatarColour: "violet",
  email: "mei@example.com",
  phone: "+65 9123 4567",
  businessName: "Mei's Cups",
  whatYouSell: "Tumblers",
  whereYouSell: "Shopee",
};

describe("defaultProfile", () => {
  it("is the demo founder the app already knows, with nothing invented", () => {
    expect(MEI).toEqual({
      displayName: "Mei Tan",
      avatarColour: "teal",
      email: "",
      phone: "",
      businessName: "",
      whatYouSell: "Insulated tumblers",
      whereYouSell: "Shopee Singapore",
    });
    expect(defaultProfile("founder:rina").whereYouSell).toBe("Shopee Malaysia");
    expect(defaultProfile(undefined)).toBe(MEI);
  });

  it("puts Mei in Singapore and Rina in Malaysia", () => {
    expect(countryOf("founder:mei")).toBe("SG");
    expect(countryOf("founder:rina")).toBe("MY");
    expect(countryOf(undefined)).toBe("SG");
  });
});

describe("parseStoredProfile", () => {
  it("falls back to the defaults when nothing is stored", () => {
    expect(parseStoredProfile(null, MEI, "SG")).toBe(MEI);
  });

  it("reads back what serializeProfile wrote", () => {
    const json = serializeProfile(edited, "SG");
    expect(json).toBeDefined();
    expect(parseStoredProfile(json ?? null, MEI, "SG")).toEqual(edited);
  });

  it("falls back to the defaults for anything that isn't a JSON object", () => {
    for (const raw of ["", "{", "not json", "null", "42", '"Mei"', "[]", '["Mei"]', "true"]) {
      expect(parseStoredProfile(raw, MEI, "SG")).toEqual(MEI);
    }
  });

  it("does not parse a value longer than any profile could be", () => {
    const huge = JSON.stringify({ ...edited, businessName: "x".repeat(PROFILE_MAX_STORED) });
    expect(parseStoredProfile(huge, MEI, "SG")).toEqual(MEI);
  });

  it("keeps the good fields and drops each bad one to its default", () => {
    const raw = JSON.stringify({
      displayName: "  Mei Lin  ",
      avatarColour: "seal", // not a choice: cinnabar is the signature's colour only
      email: "not-an-email",
      phone: 91234567, // a number, not text
      businessName: "x".repeat(81),
      whatYouSell: "Cups‮evil", // a bidi override would reorder the text on screen
      whereYouSell: "Lazada",
      extra: "ignored",
    });
    expect(parseStoredProfile(raw, MEI, "SG")).toEqual({
      ...MEI,
      displayName: "Mei Lin",
      whereYouSell: "Lazada",
    });
  });

  it("never takes an empty name", () => {
    expect(parseStoredProfile(JSON.stringify({ ...edited, displayName: "   " }), MEI, "SG").displayName).toBe("Mei Tan");
  });

  it("checks the phone against the founder's country", () => {
    const raw = JSON.stringify({ ...edited, phone: "012-345 6789" });
    expect(parseStoredProfile(raw, MEI, "SG").phone).toBe("");
    expect(parseStoredProfile(raw, MEI, "MY").phone).toBe("012-345 6789");
  });
});

describe("serializeProfile", () => {
  it("writes nothing when a field is invalid", () => {
    expect(serializeProfile({ ...edited, email: "mei@" }, "SG")).toBeUndefined();
    expect(serializeProfile({ ...edited, displayName: "" }, "SG")).toBeUndefined();
  });

  it("trims the text it writes", () => {
    const json = serializeProfile({ ...edited, businessName: "  Mei's Cups " }, "SG");
    expect(JSON.parse(json ?? "{}")).toMatchObject({ businessName: "Mei's Cups" });
  });
});

describe("fieldError", () => {
  it("accepts an empty email and phone, but not an empty name", () => {
    expect(fieldError("email", "", "SG")).toBeUndefined();
    expect(fieldError("phone", "", "SG")).toBeUndefined();
    expect(fieldError("displayName", " ", "SG")).toBe("Enter your name.");
  });

  it("says how to write an email", () => {
    expect(fieldError("email", "mei@example.com", "SG")).toBeUndefined();
    expect(fieldError("email", "mei@example", "SG")).toBe("Enter an email like name@example.com.");
  });

  it("takes a Singapore number with or without +65, spaces or dashes", () => {
    for (const ok of ["91234567", "9123 4567", "+65 6123-4567", "+6531234567"]) expect(fieldError("phone", ok, "SG")).toBeUndefined();
    for (const bad of ["1234 5678", "912345", "+60 912345678", "9123 45678", "phone"]) {
      expect(fieldError("phone", bad, "SG")).toBe("Enter 8 digits that start with 3, 6, 8 or 9. You can add +65 in front.");
    }
  });

  it("caps every text field", () => {
    expect(fieldError("businessName", "x".repeat(80), "SG")).toBeUndefined();
    expect(fieldError("businessName", "x".repeat(81), "SG")).toBe("Use 80 characters or fewer.");
  });

  it("refuses control and bidi-override characters", () => {
    expect(fieldError("whatYouSell", "Cups\u0007", "SG")).toBe("Remove the hidden characters from this.");
    expect(fieldError("displayName", "Mei⁦Tan", "SG")).toBe("Remove the hidden characters from this.");
  });
});

describe("initialsOf and firstNameOf", () => {
  it("takes the first letter of the first and last words", () => {
    expect(initialsOf("Mei Tan")).toBe("MT");
    expect(initialsOf("  mei  lin   tan ")).toBe("MT");
    expect(initialsOf("Mei")).toBe("M");
    expect(initialsOf("")).toBe("");
  });

  it("keeps whole characters in any script", () => {
    expect(initialsOf("陈 美玲")).toBe("陈美");
    expect(initialsOf("Émile Zola")).toBe("ÉZ");
  });

  it("gives the first word", () => {
    expect(firstNameOf(" Mei Tan ")).toBe("Mei");
    expect(firstNameOf("")).toBe("");
  });
});
