/**
 * The canned scenarios (default, and Malaysia) answer a quick or CFO question from the journey's templates before the
 * canned script (first-timer #30): "is my money safe?", "what do I do now?", "how are we doing?", "what did the AI pay
 * by itself?" and "who is my supplier?" get stage-appropriate answers, never the intake questions; anything else still
 * plays the script from where it was. No answer carries a signature card.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CFO_TEXT, TEXT, deriveJourney, nextStepText, type ChatMessage } from "@hogee/core";
import { app } from "../src/index";
import { readEnv } from "../src/env";
import { mockJourneyFacts } from "../src/journey/index";
import { getState, resetState } from "../src/store";
import { harness, json, secret } from "./support/harness";

const SESSION = "01a14202-2800-7000-8000-00000000c0de";
const h = harness(app);

beforeAll(() => {
  process.env.DEMO_MODE = "1";
  process.env.PERSONA_COOKIE_SECRET = secret();
  process.env.OFFICER_TOKEN = secret();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetState(readEnv());
});

interface Chunk {
  type: string;
  delta?: string;
}
async function say(message: string): Promise<Chunk[]> {
  const res = await app.request("/api/chat", { ...json({ sessionId: SESSION, message }), headers: { "content-type": "application/json", cookie: await h.cookie("founder") } });
  expect(res.status).toBe(200);
  return (await res.text())
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)) as Chunk);
}
const textOf = (chunks: readonly Chunk[]) => chunks.filter((c) => c.type === "text-delta").map((c) => c.delta).join("");
const dataTypes = (chunks: readonly Chunk[]) => chunks.filter((c) => c.type.startsWith("data-")).map((c) => c.type);
const turn = () => getState(readEnv()).chats.get(SESSION)?.turn;

describe("quick and CFO questions in the default scenario (SG)", () => {
  it("answer from templates at the seeded stage, without advancing the canned script", async () => {
    const st = getState(readEnv());
    const state = deriveJourney(await mockJourneyFacts(st, SESSION, st.profile.founderPersona));
    expect(state.stage).toBe("PLAN_ACTIVE");

    const safe = await say("Is my money safe?");
    expect(textOf(safe)).toBe(TEXT.safety);
    expect(dataTypes(safe)).toEqual([]);
    const next = await say("What do I do now?");
    expect(textOf(next)).toBe(nextStepText(state));
    expect(dataTypes(next)).toEqual(["data-next"]);
    const cfo = await say("How are we doing?");
    expect(textOf(cfo)).toBe(CFO_TEXT.overview);
    expect(dataTypes(cfo)).toEqual(["data-cfo", "data-next"]);
    expect(textOf(await say("What did the AI pay by itself?"))).toBe(TEXT.ai);
    // The seeded orders are not in this chat's history: point to the Suppliers page, never "you haven't picked one".
    expect(textOf(await say("Who is my supplier?"))).toBe(TEXT.supplierPage);
    expect(turn()).toBe(0);

    // Anything else still plays the canned script from its first turn.
    expect(textOf(await say("I want to sell custom insulated tumblers"))).toContain("Thanks, Mei.");
    expect(turn()).toBe(1);
  });

  it("stores both messages, traces each answer as a PROPOSAL, and never brings up a signature card", async () => {
    const before = getState(readEnv()).traces.length;
    for (const m of ["is it safe?", "what next?", "how is the business doing?", "did Hogee pay anything on its own?"]) expect(dataTypes(await say(m)), m).not.toContain("data-sign");
    const history = (await h.call<ChatMessage[]>(`/api/chat/${SESSION}`)).body;
    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant", "user", "assistant"]);
    const added = getState(readEnv()).traces.slice(before);
    expect(added.map((t) => [t.actor, t.kind])).toEqual(Array.from({ length: 4 }, () => ["planner", "PROPOSAL"]));
  });

  it("a deal report with numbers, or a money request, still goes to the canned script", async () => {
    expect(textOf(await say("is it safe? went with #2, 30% deposit"))).toContain("Thanks, Mei.");
    expect(textOf(await say("pay the supplier now"))).not.toBe(TEXT.outOfScope);
    expect(turn()).toBe(2);
  });
});

describe("quick questions in the default scenario for Malaysia (Rina)", () => {
  it("answer from the same templates; the canned script stays Rina's", async () => {
    vi.stubEnv("HOGEE_COUNTRY", "MY");
    resetState(readEnv());
    expect(textOf(await say("Is my money safe?"))).toBe(TEXT.safety);
    expect(textOf(await say("How are we doing?"))).toBe(CFO_TEXT.overview);
    const scripted = textOf(await say("Hi"));
    expect(scripted).toContain("Thanks, Rina.");
    expect(scripted).not.toMatch(/Mei|Singapore/);
  });
});
