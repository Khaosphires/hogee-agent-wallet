/**
 * Turns validated Reader output into taint-labelled fields. Deterministic and local:
 * - regex values (prefilter.ts) win over model values; disagreement is a flag, never silently resolved;
 * - every model number is grounded (snippet in the document, value in the snippet as a whole number) and parsed by
 *   code; a money value also needs its currency named in the snippet, and only that one (security audit run-3);
 * - every model string must occur in the document (no invented names, numbers or certificates);
 * - every value is labelled untrusted with source `reader:<kind>:<docId>`; account numbers are also private.
 */
import { snippetHash, untrusted, type ExtractedField, type Hex32, type Minor, type Untrusted } from "@hogee/core";
import { currenciesNamed, isGrounded, isNumberGrounded, normalizeCurrency, parseAmountToMinor, prefilterInvoice, type ReaderCurrency } from "./prefilter";
import type { StrictInvoice, StrictListing } from "./schemas";

export interface MoneyField {
  readonly amountMinor: Minor;
  readonly currency: ReaderCurrency;
  readonly unit: string;
  readonly sourceUrl: string | null;
  readonly snippetHash: Hex32;
  readonly method: "regex" | "llm";
}

export interface CountField {
  /** Digits only. */
  readonly value: string;
  readonly unit: string;
  readonly sourceUrl: string | null;
  readonly snippetHash: Hex32;
  readonly method: "llm";
}

export interface InvoiceFields {
  readonly invoiceNumber: Untrusted<string> | null;
  readonly issuerName: Untrusted<string> | null;
  readonly total: Untrusted<MoneyField> | null;
  readonly lineItems: Untrusted<readonly { readonly description: string; readonly quantity: CountField | null }[]>;
  /** Account numbers stated in the document (regex, never sent to a model). */
  readonly accountNumbers: Untrusted<readonly string[], "private"> | null;
}

export interface ListingFields {
  readonly sellerName: Untrusted<string> | null;
  readonly productTitle: Untrusted<string> | null;
  readonly unitPrice: Untrusted<MoneyField> | null;
  readonly moq: Untrusted<CountField> | null;
  readonly leadTimeDays: Untrusted<CountField> | null;
  readonly certificates: Untrusted<readonly string[]>;
  readonly claimsEscrow: Untrusted<boolean | null>;
}

export interface FieldContext {
  readonly text: string;
  readonly sourceUrl: string | null;
  readonly source: string;
}

type WireNumber = NonNullable<StrictInvoice["total"]>;

class Builder {
  readonly dropped: string[] = [];
  readonly extracted: Record<string, ExtractedField> = {};
  constructor(readonly ctx: FieldContext) {}

  label<T>(v: T): Untrusted<T> {
    return untrusted(v, this.ctx.source);
  }

  /** A model string that must occur verbatim (case/whitespace-insensitive) in the document. */
  text(name: string, v: string | null): Untrusted<string> | null {
    if (v === null) return null;
    if (isGrounded(this.ctx.text, v, v)) return this.label(v);
    this.dropped.push(name);
    return null;
  }

  /** The currency comes from the model, so the snippet must name it, and no other Reader currency. */
  money(name: string, n: WireNumber | null, currencyHint: string | null): MoneyField | null {
    if (n === null) return null;
    const currency = normalizeCurrency(n.unit) ?? normalizeCurrency(currencyHint);
    const amountMinor = currency ? parseAmountToMinor(n.value, currency) : null;
    const named = currenciesNamed(n.snippet);
    const currencyGrounded = currency !== null && named.length === 1 && named[0] === currency;
    if (!currency || amountMinor === null || !currencyGrounded || !isNumberGrounded(this.ctx.text, n.snippet, n.value)) {
      this.dropped.push(name);
      return null;
    }
    const field: MoneyField = { amountMinor, currency, unit: currency, sourceUrl: this.ctx.sourceUrl, snippetHash: snippetHash(n.snippet), method: "llm" };
    this.extracted[name] = { value: amountMinor, unit: currency, snippetHash: field.snippetHash };
    return field;
  }

  count(name: string, n: WireNumber | null): CountField | null {
    if (n === null) return null;
    const digits = n.value.replace(/,/g, "");
    if (!/^\d{1,12}$/.test(digits) || !isNumberGrounded(this.ctx.text, n.snippet, n.value)) {
      this.dropped.push(name);
      return null;
    }
    const field: CountField = { value: String(BigInt(digits)), unit: n.unit, sourceUrl: this.ctx.sourceUrl, snippetHash: snippetHash(n.snippet), method: "llm" };
    this.extracted[name] = { value: field.value, unit: field.unit.slice(0, 32), snippetHash: field.snippetHash };
    return field;
  }
}

export function buildInvoiceFields(data: StrictInvoice, ctx: FieldContext) {
  const b = new Builder(ctx);
  const pre = prefilterInvoice(ctx.text);
  // Too many PayNow mentions or account labels to read them all: the payout details cannot be confirmed unchanged.
  const extraFlags: string[] = pre.payoutScanCapped ? ["PAYEE_DETAILS_CHANGED"] : [];
  const llmTotal = b.money("total", data.total, data.currency);
  const stated = pre.totals[0];
  let total: MoneyField | null = llmTotal;
  if (stated) {
    total = { amountMinor: stated.amountMinor, currency: stated.currency, unit: stated.currency, sourceUrl: ctx.sourceUrl, snippetHash: stated.snippetHash, method: "regex" };
    b.extracted.total = { value: stated.amountMinor, unit: stated.currency, snippetHash: stated.snippetHash };
    const amounts = new Set(pre.totals.map((t) => `${t.currency}:${t.amountMinor}`));
    if (llmTotal) amounts.add(`${llmTotal.currency}:${llmTotal.amountMinor}`);
    if (amounts.size > 1) extraFlags.push("AMOUNT_MISMATCH");
  }
  const invoiceNumber = pre.invoiceNumber !== null ? b.label(pre.invoiceNumber) : b.text("invoiceNumber", data.invoiceNumber);
  const lineItems = data.lineItems.flatMap((li, i) => {
    if (!isGrounded(ctx.text, li.description, li.description)) {
      b.dropped.push(`lineItems.${i}`);
      return [];
    }
    return [{ description: li.description, quantity: b.count(`lineItems${i}Quantity`, li.quantity) }];
  });
  const fields: InvoiceFields = {
    invoiceNumber,
    issuerName: b.text("issuerName", data.issuerName),
    total: total ? b.label(total) : null,
    lineItems: b.label(lineItems),
    accountNumbers: pre.accountNumbers.length > 0 ? untrusted(pre.accountNumbers, ctx.source, "private") : null,
  };
  return { fields, extraFlags, dropped: b.dropped, extracted: b.extracted };
}

export function buildListingFields(data: StrictListing, ctx: FieldContext) {
  const b = new Builder(ctx);
  const unitPrice = b.money("unitPrice", data.unitPrice, data.currency);
  const moq = b.count("moq", data.moq);
  const leadTimeDays = b.count("leadTimeDays", data.leadTimeDays);
  const certificates = data.certificates.filter((c, i) => {
    const ok = isGrounded(ctx.text, c, c);
    if (!ok) b.dropped.push(`certificates.${i}`);
    return ok;
  });
  const fields: ListingFields = {
    sellerName: b.text("sellerName", data.sellerName),
    productTitle: b.text("productTitle", data.productTitle),
    unitPrice: unitPrice ? b.label(unitPrice) : null,
    moq: moq ? b.label(moq) : null,
    leadTimeDays: leadTimeDays ? b.label(leadTimeDays) : null,
    certificates: b.label(certificates),
    claimsEscrow: b.label(data.claimsEscrow),
  };
  return { fields, dropped: b.dropped, extracted: b.extracted };
}
