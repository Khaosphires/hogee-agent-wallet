import { describe, expect, it } from "vitest";
import { CHAT_DATA_PART_TYPES, G0_CHAT_DATA_PART_TYPES } from "@hogee/core";
import { cardTestId } from "./types";

describe("cardTestId", () => {
  it("is card-<part name> for every chat-first part", () => {
    expect(cardTestId("data-needs")).toBe("card-needs");
    const fresh = CHAT_DATA_PART_TYPES.filter((t) => !(G0_CHAT_DATA_PART_TYPES as readonly string[]).includes(t));
    expect(fresh.map(cardTestId)).toEqual(["card-needs", "card-sign", "card-next", "card-action", "card-search", "card-candidates", "card-enquiry", "card-terms", "card-order", "card-cfo"]);
  });
});
