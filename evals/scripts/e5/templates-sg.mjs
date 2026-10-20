/**
 * E5 documents for Singapore (docs.sg.jsonl, merged into docs.jsonl by P1 once core's PII_ENTITIES has
 * SG_NRIC and SG_PHONE): permit emails, PayNow notices, chats, invoices and quotes in English, Malay and
 * Chinese, with UENs, postcodes and SGD amounts as hard negatives. Same part format as templates.mjs.
 */
import * as D from "./decoys.mjs";
import { genMyBank, genMyPhone, genSgNric, genSgPhone } from "./ids.mjs";
import { BUSINESSES as B, NAMES as N, PLACES as P, PRODUCTS } from "./pools.mjs";
import { T, clock, doc } from "./templates.mjs";

const qtyOf = (r) => r.int(2, 20) * 50;
const first = (name) => name.split(" ")[0];

function sgPermit(r) {
  const p = r.pick(PRODUCTS);
  const sgd = D.moneyFmt(r, "SGD");
  const cif = r.int(800, 9000) * 100;
  return doc("en", "permit_email", "SG", T`Subject: Import permit for B/L ${D.billOfLading(r)}

Hi ${r.pick(N.sg)},

Your ${qtyOf(r)} pcs ${p.en} (HS ${D.hsCode(r, p.hs)}) from ${r.pick(P.cnPortEn)} will arrive at Pasir Panjang Terminal on ${D.date(r, "en")}.
To apply for the import permit, please confirm the importer details:
Business name: ${r.pick(B.sgShop)}
UEN: ${D.uen(r, "A")}
Owner NRIC: ${genSgNric(r, r.pick(["S", "S", "T"]))}
Mobile: ${genSgPhone(r)}

CIF value: ${sgd(cif)}
GST payable at import (9% of CIF): ${sgd(Math.round(cif * 0.09))}
Permit and handling fee: ${sgd(r.int(40, 120) * 100)}

Regards,
${r.pick(N.sg)}
${r.pick(B.sgForwarder)}
Tel: ${genSgPhone(r, "landline")}`);
}

function sgNotice(r) {
  return doc("en", "marketplace_notice", "SG", T`Seller Centre: confirm your PayNow details

Hi ${r.pick(B.sgShop)},
Payouts for orders ${D.orderId(r, "shopee")} and ${D.orderId(r, "shopee")} (${D.amount(r, "SGD", 40, 600)}) are paused until you confirm:
Registered name: ${r.pick(N.sg)}
NRIC/FIN: ${genSgNric(r)}
PayNow mobile: ${genSgPhone(r)}
Business UEN: ${D.uen(r, "A")}
If you did not make this change, contact us from your registered email address.`);
}

function sgChat(r) {
  const t = clock(r);
  const [a, b] = [first(r.pick(N.sg)), r.pick(B.sgShop)];
  const phone = genSgPhone(r);
  return doc("en", "chat", "SG", T`${t()} ${a}: Hi, I ordered 2 tumblers, order ${D.orderId(r, "shopee")}. Can deliver tomorrow?
${t()} ${b}: Can! Please send your contact number 😊
${t()} ${a}: ${phone}
${t()} ${b}: Noted. Same address at ${r.pick(P.sg)}, Singapore ${D.postcode(r, "SG")}?
${t()} ${a}: Yes
${t()} ${b}: The refund for the dented cup will go to your PayNow number, ok?
${t()} ${a}: Ok, PayNow to ${phone}`);
}

function sgInvoice(r) {
  const sgd = D.moneyFmt(r, "SGD");
  const qty = qtyOf(r);
  const subtotal = qty * r.int(60, 180);
  const gst = Math.round(subtotal * 0.09);
  const uen = D.uen(r, "B");
  return doc("en", "invoice", "SG", T`TAX INVOICE ${D.invoiceNo(r)}
${r.pick(B.sgPrinter)}
UEN / GST Reg. No.: ${uen}
${r.pick(P.sg)}, Singapore ${D.postcode(r, "SG")}
Tel: ${genSgPhone(r, "landline")}

Bill to: ${r.pick(N.sg)}, ${r.pick(B.sgShop)}
Mobile: ${genSgPhone(r)}
Date: ${D.date(r, "en")}

Custom printed mailer boxes x ${qty}: ${sgd(subtotal)}
GST 9%: ${sgd(gst)}
Total: ${sgd(subtotal + gst)}
PayNow to UEN ${uen} within 14 days.`);
}

function sgZhQuote(r) {
  const p = r.pick(PRODUCTS);
  const qty = qtyOf(r);
  const usd = D.moneyFmt(r, "USD");
  const unit = r.int(3, 12) * 50;
  return doc("zh", "quote", "SG", T`报价单 ${D.quoteNo(r)}
日期：${D.date(r, "zh")}
供应商：${r.pick(B.cnZh)}
客户：${r.pick(N.sgZh)}（新加坡 ${r.pick(B.sgShop)}）
联系电话：${genSgPhone(r)}
公司注册号（UEN）：${D.uen(r)}
产品：${p.zh}，${qty} 个，单价 ${usd(unit)}，合计 ${usd(unit * qty)}
海关编码：${D.hsCode(r, p.hs)}`);
}

function sgFromJohor(r) {
  const p = r.pick(PRODUCTS);
  const { bank, value } = genMyBank(r);
  return doc("en", "quote", "SG", T`Hi ${first(r.pick(N.sg))}, this is ${r.pick(N.my)} from ${r.pick(B.myWholesale)}, Johor Bahru.
Quote for ${qtyOf(r)} pcs ${p.en}: ${D.amount(r, "SGD", 300, 3000)}, delivered to Singapore via Woodlands on ${D.date(r, "en")}.
Please pay to our ${bank} account ${value}, we cannot take PayNow.
Call or WhatsApp me at ${genMyPhone(r)}.
Our driver will call you at ${genSgPhone(r)} on the delivery day.`);
}

function sgFinChat(r) {
  const [a, b] = [first(r.pick(N.cnEn)), "Onboarding"];
  return doc("en", "chat", "SG", T`${a}: Hi, I am registering my Pte Ltd as a seller. Which ID do you need from a foreign director?
${b}: Your FIN and a local contact number please.
${a}: FIN ${genSgNric(r, r.pick(["F", "G", "M"]))}, mobile ${genSgPhone(r)}
${b}: Thanks. And the company UEN?
${a}: ${D.uen(r, "B")}`);
}

function sgSummary(r) {
  const [p1, p2] = [r.pick(PRODUCTS), r.pick(PRODUCTS)];
  return doc("en", "order_summary", "SG", T`Weekly summary - ${r.pick(B.sgShop)}
Order ${D.orderId(r, "shopee")}: 2 x ${p1.en}, ${D.amount(r, "SGD", 20, 90)}, delivered ${D.date(r, "en")}
Order ${D.orderId(r, "shopee")}: 1 x ${p2.en}, ${D.amount(r, "SGD", 10, 60)}, in transit, tracking ${D.tracking(r, "SG")}
Supplier payment ${D.invoiceNo(r)}: ${D.amount(r, "SGD", 300, 5000)}, on-chain record ${D.txHash(r)}
Forwarder: ${r.pick(B.sgForwarder)} (UEN ${D.uen(r, r.pick(["B", "C"]))})
Next arrival: container ${D.container(r)}, HS ${D.hsCode(r, p1.hs)}, to Singapore ${D.postcode(r, "SG")}`);
}

function sgMsChat(r) {
  const name = r.pick(N.sgMs);
  return doc("ms", "chat", "SG", T`${first(name)}: Salam, saya nak tukar alamat penghantaran untuk order ${D.orderId(r, "shopee")}
Khidmat Pelanggan: Boleh. Sila beri nama penuh dan nombor telefon
${first(name)}: ${name}, ${genSgPhone(r)}
Khidmat Pelanggan: Untuk pengesahan pemilik kedai, sila beri No. IC
${first(name)}: ${genSgNric(r, r.pick(["S", "T"]))}
Khidmat Pelanggan: Terima kasih, alamat baharu akan digunakan mulai ${D.date(r, "ms")}`);
}

function sgZhChat(r) {
  const a = r.pick(N.sgZh);
  return doc("zh", "chat", "SG", T`${a}：你好，我在 Shopee 下单了，单号 ${D.orderId(r, "shopee")}
客服：收到😊 请留个联系电话
${a}：${genSgPhone(r)}
客服：好的，司机明天下午送到 ${r.pick(P.sg)}
${a}：如果我不在家，请打我先生的电话 ${genSgPhone(r)}`);
}

/** Template name → [function, document count]. Counts sum to 40. */
export const SG_PLAN = {
  sgPermit: [sgPermit, 6],
  sgNotice: [sgNotice, 5],
  sgChat: [sgChat, 5],
  sgInvoice: [sgInvoice, 5],
  sgZhQuote: [sgZhQuote, 3],
  sgFromJohor: [sgFromJohor, 4],
  sgFinChat: [sgFinChat, 3],
  sgSummary: [sgSummary, 4],
  sgMsChat: [sgMsChat, 2],
  sgZhChat: [sgZhChat, 3],
};
