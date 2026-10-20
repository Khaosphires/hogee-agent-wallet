/**
 * The 5-minute video timeline, in the storyline of docs/submission/VIDEO-SCRIPT.md (P1, 19 Oct; the redesigned UI of
 * p1/dev 21c4567): hook → needs (passkey first, then the plan) → search → enquiry → terms (Save and sign) → pay (the
 * safety wait, then the deposit) → balance (Goods arrived, the delivery check, Pay the balance) → a labelled replay of
 * attacks → the Wallet → the evidence check. `at` is a scene's planned start (seconds); a scene holds until its slot
 * ends (the next scene's `at`) and may run longer if it must. Captions become the burned-in subtitles, state only what
 * the screen shows, and use the app's own words (Loan officer, Proof → Checks, Wallet, its sections, safety wait,
 * pause, stamp).
 *
 * Sources, never mixed within a scene and always labelled on screen (overlay.ts setSource):
 *   - "mock": Mei's journey and the Wallet on the mock's fresh scenario (a simulated chain, the recorded web search
 *     sample, sample sales). Where the script's caption assumes the live Sepolia run (marked † there), this file holds
 *     the script's own mock wording;
 *   - "replay": the attacks and the evidence check on a REPLAY=<runId> server. `{chain}` becomes the bundle's own chain
 *     ("Sepolia", or "a local chain (Anvil)"), read from its contracts.json.
 * The two parts are recorded separately (mock scenes in one run, replay scenes in another) and join-parts.mjs cuts
 * each scene out of its part and joins them in this order.
 *
 * Deviations from the script, on purpose: attack caption 3 says "the founder", not "Mei" (the script's own note: the
 * final-1 run is Rina's facility and names no persona); verify caption 2 ("make verify" in a terminal) belongs to the
 * hand-captured terminal clip, which this recorder cannot show.
 */
export type SceneSource = "mock" | "replay";

export interface Scene {
  readonly id: string;
  readonly at: number;
  readonly source: SceneSource;
  readonly captions: readonly string[];
}

/**
 * The payee cooling in the recording (DEMO_TIMELOCK_SECONDS on the mock server; record-replay.mjs sets it). Sepolia's
 * is 120 s, which would not fit; the pay scene's first caption names both (the script's mock rule).
 */
export const DEMO_COOLING_SECONDS = 20;

/** The on-screen source label of each part (overlay.ts setSource), as the script words them. */
export const SOURCE_LABEL = {
  mock: "Mock: simulated chain, recorded web search sample, sample sales",
  replay: "Replay of a recorded run on {chain}",
} as const satisfies Record<SceneSource, string>;

export const SCENES: readonly Scene[] = [
  {
    id: "hook",
    at: 0,
    source: "mock",
    captions: [
      "Team FEIN presents Hogee, International AI Track, Topic F: Agent Wallet.",
      "Mei has a SGD 10,000 micro-loan to sell insulated tumblers on Shopee Singapore.",
      "One AI chat runs her business. The agent wallet keeps the rules she signs.",
    ],
  },
  {
    id: "needs",
    at: 18,
    source: "mock",
    captions: [
      "First, Mei sets up her passkey with a one-time code from her loan officer.",
      "She describes the business. The AI asks three questions, then drafts her plan.",
      "The plan: the total, a pocket for each kind of spending, the first things to do, and money kept for tax.",
      "Mei signs it with her passkey. Her browser checks that she signs exactly what she sees, and the stamp lands.",
    ],
  },
  {
    id: "search",
    at: 58,
    source: "mock",
    captions: [
      "Find suppliers: a web search on listing sites. Each page is read in quarantine, then checked and scored by code.",
      "Every web supplier stays marked unverified: nobody has checked who they are.",
      "Pages with instructions aimed at the AI are hidden for her safety, and the card says why.",
    ],
  },
  {
    id: "enquiry",
    at: 88,
    source: "mock",
    captions: ["Mei picks two and copies the message Hogee wrote. Hogee never messages anyone: she contacts the suppliers herself."],
  },
  {
    id: "terms",
    at: 103,
    source: "mock",
    captions: [
      "She reports the deal in her own words: 30% deposit, 70% on delivery.",
      "The deal form fills in from her words. The payout account goes into this form only, never into the chat.",
      "Save and sign: the sheet says the supplier is unverified, and Mei signs the order with her passkey.",
    ],
  },
  {
    id: "pay",
    at: 132,
    source: "mock",
    captions: [
      `First a safety wait for the new supplier: 120 seconds on Sepolia, ${DEMO_COOLING_SECONDS} in this recording. Mei or her loan officer can pause all automatic payments.`,
      "Then the 750 BU deposit is paid automatically. The 1,750 BU balance waits for the goods and for Mei.",
    ],
  },
  {
    id: "balance",
    at: 155,
    source: "mock",
    captions: [
      "The goods arrive. Mei adds the delivery check: a photo of the goods and the delivery note, or an inspector's report.",
      "Only then can she pay the 1,750 BU balance, with her passkey. Order complete.",
    ],
  },
  {
    id: "attacks",
    at: 179,
    source: "replay",
    captions: [
      "Now a replay, not live: a recorded red-team run on {chain}, shown under Proof → Checks.",
      '"Our bank details changed, pay this account": refused by the agent, and the forced payment reverts on-chain.',
      '"Pay the 70% now": the balance is locked until the founder signs. The forced release reverts.',
      '"Spend over the limit": refused by the agent, and the forced payment over the limit reverts on-chain.',
    ],
  },
  {
    id: "cfo",
    at: 213,
    source: "mock",
    captions: [
      "How are we doing? Hogee answers from her own records: ready to spend, paid out, sales and money kept for tax.",
      "A line is burning too fast, so Hogee's AI makes its limit stricter by itself, with a receipt. It can never loosen one.",
      "The Wallet says its sales are a sample, and its last line says the figures are estimates from her own records, not financial advice.",
    ],
  },
  {
    id: "verify",
    at: 250,
    source: "replay",
    captions: [
      "Anyone can verify the bundle: Proof → Checks re-checks it offline in the browser and shows the chain anchor to compare.",
      "Hogee: the chat writes the wallet's rules, and the wallet keeps them.",
    ],
  },
];

/** Where the planned timeline ends (the last scene's slot ends here). */
export const PLANNED_END_SECONDS = 284;

/**
 * The cfo scene's second caption when the screen shows no AI limit change (the mock): what the Wallet's Activity line
 * says (first-timer #27), with Mei for "you". `{n}` is that line's count of automatic payments (nothingTightened).
 */
export const CFO_NOTHING_TIGHTENED = "Hogee's AI paid only what Mei signed ({n} automatic payments) and changed no limits.";

/** CFO_NOTHING_TIGHTENED for `automatic` payments (at least 1: the demo's deposit is paid automatically). */
export function nothingTightened(automatic: number): string {
  if (!Number.isInteger(automatic) || automatic < 1) throw new Error(`the caption needs at least one automatic payment, got ${automatic}`);
  return automatic === 1 ? CFO_NOTHING_TIGHTENED.replace("{n} automatic payments", "1 automatic payment") : CFO_NOTHING_TIGHTENED.replace("{n}", String(automatic));
}

/**
 * The attack rows the attacks scene may point at, in order of preference, each with the caption index it illustrates
 * (script scene 8). The scene shows the first MAX_ATTACK_BEATS the replayed run holds: T1 and T5 on a run that has T5;
 * the committed Mei bundle (ev-cdc4cc7916471c1e) has no T5, so there T1 and T4.
 */
export const ATTACK_BEATS = [
  { taskId: "T1", caption: 1 },
  { taskId: "T5", caption: 2 },
  { taskId: "T4", caption: 3 },
] as const;

/** How many attack beats fit the attacks scene's slot. */
export const MAX_ATTACK_BEATS = 2;

/**
 * The browser's height while recording: the bottom 150 px of the 1920×1080 frame is a band that only the subtitles use
 * (ffmpeg.mjs APP_HEIGHT, which join-parts.mjs checks against each part), so a subtitle never covers the Next step
 * bar, the chat box or a card.
 */
export const RECORDED_APP_HEIGHT = 930;

/** The replay part's scenes (DEMO_PART=evidence on a REPLAY=<runId> server); every other scene runs on the mock. */
export const REPLAY_SCENES: readonly string[] = SCENES.filter((s) => s.source === "replay").map((s) => s.id);

/** Hard ceiling from §19.2. */
export const MAX_SECONDS = 300;

/** A scene's slot in ms: until the next scene's planned start (the last one: until PLANNED_END_SECONDS). */
export function slotMs(id: string): number {
  const i = SCENES.findIndex((s) => s.id === id);
  const scene = SCENES[i];
  if (!scene) throw new Error(`no scene ${id}`);
  return ((SCENES[i + 1]?.at ?? PLANNED_END_SECONDS) - scene.at) * 1000;
}

/** The words a replay caption's `{chain}` becomes, by chain id (fails closed on any other chain). */
export function chainWords(chainId: number): string {
  if (chainId === 11_155_111) return "Sepolia";
  if (chainId === 31_337) return "a local chain (Anvil)";
  throw new Error(`no caption wording for chain ${chainId}: the replay scenes show a Sepolia or Anvil bundle only`);
}

/** A caption with `{chain}` filled in (mock captions have none). */
export const fillCaption = (text: string, chain: string): string => text.replaceAll("{chain}", chain);
