/**
 * The live plan reply (UX-PLAN REWRITES A2.59-A2.64): the explainer's total, budget releases and the most the AI could
 * pay, then what to do next; the per-pocket sentences stay on the card below the reply.
 */
import { describe, expect, it } from "vitest";
import type { PlanExplanation } from "@hogee/agent";
import { planReplyText } from "../src/journey/planner";

const ex: PlanExplanation = {
  sentences: [
    { templateId: "plan.total", text: "Here's your plan: 10,000 BU in 6 pockets. 5% of each sale is kept for tax." },
    { templateId: "plan.line", text: "Supplier: 5,000 BU. At most 2,500 BU per payment and 5,000 BU per 7 days." },
    { templateId: "plan.pacing", text: "Ads: at most 75 BU per day." },
    { templateId: "plan.stage.gated", text: "You get 4,000 BU when you sign." },
    { templateId: "plan.payees", text: "Your wallet can only pay the marketplace's own accounts and suppliers you approve." },
    { templateId: "plan.blast", text: "Even if someone took over the AI, the most it could pay out under these rules is 4,000 BU." },
  ],
  text: "",
};

describe("planReplyText", () => {
  it("keeps the total, the releases and the most the AI could pay, then says what to do next", () => {
    expect(planReplyText(ex)).toBe(
      "Here's your plan: 10,000 BU in 6 pockets. 5% of each sale is kept for tax. You get 4,000 BU when you sign. Even if someone took over the AI, the most it could pay out under these rules is 4,000 BU. Read it below, then sign it with your passkey.",
    );
  });
});
