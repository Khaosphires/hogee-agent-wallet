import { describe, expect, it } from "vitest";
import { API_ERROR_COPY, CONSTITUTION_COPY, CONSTITUTION_RULE_COPY, CONTRACT_ERROR_COPY } from "../src/index";

// project.md D5: words the UI never shows (whole words, any case, plurals included).
const BANNED = /(?<![\p{L}\p{N}_])(tokens?|tokeni[sz]ed|coins?|stablecoins?|usdc|x402|defi|rwa|purpose-bound money)(?![\p{L}\p{N}_])|代币|通证|发行|交易/iu;

const texts: readonly [string, string][] = [
  ...Object.entries(CONTRACT_ERROR_COPY).flatMap(([k, c]) => [[`${k}.title`, c.title], [`${k}.detail`, c.detail]] as [string, string][]),
  ...Object.entries(API_ERROR_COPY).flatMap(([k, c]) => [[`${k}.title`, c.title], [`${k}.detail`, c.detail]] as [string, string][]),
  ...Object.entries(CONSTITUTION_COPY),
  ...Object.entries(CONSTITUTION_RULE_COPY),
];

describe("error copy wording", () => {
  it("never uses a banned word (it is shown in the timeline, the evidence explorer and error toasts)", () => {
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.filter(([, text]) => BANNED.test(text))).toEqual([]);
  });
});

describe("who can cancel a waiting change (UX-PLAN D21)", () => {
  it("names the founder and the loan officer, never anyone (TreasuryGovernance.cancelLoosen L142-147)", () => {
    const { detail } = CONTRACT_ERROR_COPY.TimelockActive;
    expect(detail).toMatch(/founder or the loan officer can cancel/);
    expect(texts.filter(([, text]) => /\banyone (can|may) (veto|cancel)/i.test(text))).toEqual([]);
  });
});
