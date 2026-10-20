/**
 * What a chat session's own history says about the journey (pure; the live API and the mock read it the same way):
 * the action ids already used (single use per session, VISION-DECISIONS §9), the latest pick, an open terms pre-fill,
 * the latest saved terms id and the labels of the buttons the server sent. Only parts that pass ChatDataPart.parse
 * count, and a data-action counts only on a user message: a stored part that does not parse is ignored here (and
 * dropped from GET /api/chat by the caller).
 *
 * Only the HISTORY_PART_TYPES parts are read, so a store may hand over every message of the session with just those
 * parts (the live API's projection query, audit run-9 lead 2): the result is the same as over the full messages, as
 * long as every message keeps its place (a press's reply is the NEXT message). One pass over the parts.
 */
import { ChatDataPart } from "../schemas/chat";
import type { ChatAction } from "../schemas/journey";
import type { SupplierId } from "../schemas/primitives";

/** The part types readHistory reads; every other part (text, cards that read REST) never changes its result. */
export const HISTORY_PART_TYPES = ["data-action", "data-next", "data-enquiry", "data-sign", "data-search", "data-shortlist", "data-terms", "data-plan-draft"] as const;

export interface HistoryMessage {
  readonly role: string;
  readonly parts: readonly unknown[];
}

export interface JourneyHistory {
  readonly usedActionIds: ReadonlySet<string>;
  /** The latest pick action that took effect (its search and suppliers). */
  readonly lastPick: { readonly searchId: string; readonly supplierIds: readonly SupplierId[] } | null;
  /** The supplier of the newest data-terms pre-fill shown after the latest saved terms and the latest list. */
  readonly openTermsSupplierId: SupplierId | null;
  /** The termsId of the latest terms_saved action. */
  readonly lastSavedTermsId: string | null;
  /** Every confirmed terms_saved termsId, oldest first (the mock reads the newest one its store knows). */
  readonly savedTermsIds: readonly string[];
  /** The latest data-plan-draft the assistant showed. */
  readonly latestDraftId: string | null;
  /** The latest supplier list the assistant started: a web search (data-search) or the catalog (data-shortlist). */
  readonly latestList: { readonly origin: "web" | "catalog"; readonly id: string } | null;
  /** The label of the data-next button that carried this action id, if the server sent one. */
  buttonLabel(actionId: string): string | null;
}

interface Seen {
  readonly index: number;
  /** Position of the message in the session. */
  readonly message: number;
  readonly part: ChatDataPart;
  readonly role: string;
}

function dataParts(messages: readonly HistoryMessage[]): Seen[] {
  const out: Seen[] = [];
  let index = 0;
  for (const [message, m] of messages.entries()) {
    for (const raw of m.parts) {
      index += 1;
      const p = ChatDataPart.safeParse(raw);
      if (!p.success) continue;
      if (p.data.type === "data-action" && m.role !== "user") continue;
      out.push({ index, message, part: p.data, role: m.role });
    }
  }
  return out;
}

interface Pressed {
  readonly index: number;
  readonly message: number;
  readonly action: ChatAction;
}

const actionsOf = (seen: readonly Seen[]): Pressed[] =>
  seen.flatMap((s) => (s.part.type === "data-action" ? [{ index: s.index, message: s.message, action: s.part.data.action }] : []));

/** The assistant's parts per message position (each reply is then looked up once, not by scanning every part). */
function repliesOf(seen: readonly Seen[]): ReadonlyMap<number, readonly ChatDataPart[]> {
  const out = new Map<number, ChatDataPart[]>();
  for (const s of seen) {
    if (s.role !== "assistant") continue;
    const parts = out.get(s.message);
    if (parts) parts.push(s.part);
    else out.set(s.message, [s.part]);
  }
  return out;
}

/**
 * A press counts for the journey only if the server's reply to it (the next message) shows it took effect, or if it
 * is the press being answered now (the last message). A refused pick (no enquiry) or a terms_saved the server did not
 * confirm (no SupplierApproval card for those terms) still uses its id but changes nothing.
 */
function tookEffect(p: Pressed, messageCount: number, replies: ReadonlyMap<number, readonly ChatDataPart[]>): boolean {
  if (p.message === messageCount - 1) return true;
  const reply = replies.get(p.message + 1) ?? [];
  if (p.action.type === "pick") return reply.some((x) => x.type === "data-enquiry");
  if (p.action.type === "terms_saved") {
    const termsId = p.action.termsId;
    return reply.some((x) => x.type === "data-sign" && x.data.kind === "SupplierApproval" && x.data.refId === termsId);
  }
  return true;
}

const lastIndex = <T extends { index: number }>(xs: readonly T[]): number => xs.at(-1)?.index ?? 0;

export function readHistory(messages: readonly HistoryMessage[]): JourneyHistory {
  const seen = dataParts(messages);
  const actions = actionsOf(seen);
  const replies = repliesOf(seen);
  const picks = actions.filter((a) => a.action.type === "pick" && tookEffect(a, messages.length, replies));
  const saves = actions.filter((a) => a.action.type === "terms_saved" && tookEffect(a, messages.length, replies));
  const lists = seen.filter((s) => s.part.type === "data-search" || s.part.type === "data-shortlist");
  const prefills = seen.filter((s) => s.part.type === "data-terms");
  const labels = new Map<string, string>();
  for (const s of seen) {
    if (s.part.type === "data-next" && s.role === "assistant") for (const b of s.part.data.actions) labels.set(b.action.actionId, b.label);
  }
  const pick = picks.at(-1)?.action;
  const save = saves.at(-1)?.action;
  const openAfter = Math.max(lastIndex(saves), lastIndex(lists));
  const open = prefills.at(-1);
  const list = lists.at(-1)?.part;
  const draft = seen.filter((s) => s.part.type === "data-plan-draft").at(-1)?.part;
  return {
    usedActionIds: new Set(actions.map((a) => a.action.actionId)),
    lastPick: pick?.type === "pick" ? { searchId: pick.searchId, supplierIds: pick.supplierIds } : null,
    openTermsSupplierId: open && open.index > openAfter && open.part.type === "data-terms" ? open.part.data.supplierId : null,
    lastSavedTermsId: save?.type === "terms_saved" ? save.termsId : null,
    savedTermsIds: saves.flatMap((x) => (x.action.type === "terms_saved" ? [x.action.termsId] : [])),
    latestDraftId: draft?.type === "data-plan-draft" ? draft.data.draftId : null,
    latestList:
      list?.type === "data-search" ? { origin: "web", id: list.data.searchId } : list?.type === "data-shortlist" ? { origin: "catalog", id: list.data.requestId } : null,
    buttonLabel: (actionId) => labels.get(actionId) ?? null,
  };
}

/**
 * The terms this session saved (terms_saved presses that took effect, the one being answered now included), the latest
 * save first and each id once. The journey's terms are the first of these the store knows (critic gap 2: never another
 * session's newest terms row), so a sign card only ever offers terms this conversation saved.
 */
export function termsIdsNewestFirst(history: Pick<JourneyHistory, "savedTermsIds">): string[] {
  return [...new Set([...history.savedTermsIds].reverse())];
}
