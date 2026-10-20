/**
 * E5 documents for Malaysia and Indonesia (docs.jsonl): supplier quotes, invoices, chats, customs and
 * permit emails, marketplace notices, receipts and order summaries in English, Malay, Indonesian and
 * Chinese. Each template takes a seeded rng and returns { lang, docType, country, parts }; parts are
 * plain strings, entity values ({entity, text, format}) and decoys ({decoy, text}).
 */
import * as D from "./decoys.mjs";
import { genIdPhone, genMyBank, genMyKad, genMyPhone, genNik, genNpwp, pad } from "./ids.mjs";
import { BUSINESSES as B, NAMES as N, PLACES as P, PRODUCTS } from "./pools.mjs";

export const T = (strings, ...vals) =>
  strings.flatMap((s, i) => (i < vals.length ? [s, typeof vals[i] === "number" ? String(vals[i]) : vals[i]] : [s]));
export const doc = (lang, docType, country, parts) => ({ lang, docType, country, parts });
/** Chat timestamps that only move forward. */
export function clock(r) {
  let minutes = r.int(8 * 60, 20 * 60);
  return () => {
    minutes += r.int(1, 9);
    return `[${pad(Math.floor(minutes / 60) % 24, 2)}:${pad(minutes % 60, 2)}]`;
  };
}
const qtyOf = (r) => r.int(4, 30) * 50;
const firstName = (full) => full.split(" ")[0];

// ---- English (Malaysian founder) ------------------------------------------------------------------
function enQuote(r) {
  const p = r.pick(PRODUCTS);
  const qty = qtyOf(r);
  const usd = D.moneyFmt(r, "USD");
  const day = D.dateSeq(r, "en");
  const unit = r.int(3, 12) * 50;
  return doc("en", "quote", "MY", T`QUOTATION ${D.quoteNo(r)}
Date: ${day()}
From: ${r.pick(B.cnEn)}, China
Sales contact: ${r.pick(N.cnEn)}
To: ${r.pick(N.my)}, ${r.pick(B.myShop)} (Malaysia), tel ${genMyPhone(r)}

Item: ${p.en}, MOQ ${qty} pcs
HS code: ${D.hsCode(r, p.hs)}
Unit price: ${usd(unit)} FOB ${r.pick(P.cnPortEn)}
Total for ${qty} pcs: ${usd(unit * qty)}
Lead time: ${r.int(15, 35)} days after the 30% deposit.
This quote is valid until ${day(14, 30)}.`);
}

function enInvoice(r) {
  const seller = r.pick(B.myPrinter);
  const place = r.pick(P.my);
  const { bank, value } = genMyBank(r);
  const qty = qtyOf(r);
  const rm = D.moneyFmt(r, "MYR");
  const [box, card, ship] = [qty * r.int(90, 180), qty * r.int(10, 30), r.int(15, 60) * 100];
  return doc("en", "invoice", "MY", T`INVOICE ${D.invoiceNo(r)}
${seller}
Company No. ${D.ssm(r)}
${place.addr}
Tel: ${genMyPhone(r, "landline", place.area)}

Date: ${D.date(r, "en")}
Bill to: ${r.pick(N.my)}, ${r.pick(B.myShop)}
Mobile: ${genMyPhone(r)}

1. Printed mailer box 20 x 15 x 8 cm, qty ${qty}: ${rm(box)}
2. Thank-you card, qty ${qty}: ${rm(card)}
Delivery: ${rm(ship)}
Total payable: ${rm(box + card + ship)}

Payment to ${bank}, account name ${seller}, A/C No. ${value}
Please use the invoice number as your payment reference.`);
}

function enCustoms(r) {
  const name = r.pick(N.my);
  const p = r.pick(PRODUCTS);
  const day = D.dateSeq(r, "en");
  return doc("en", "customs_email", "MY", T`Subject: Customs declaration for B/L ${D.billOfLading(r)}

Hi ${name},

Your shipment of ${qtyOf(r)} pcs ${p.en} (HS ${D.hsCode(r, p.hs)}) from ${r.pick(P.cnPortEn)} arrived at Port Klang on ${day()}.
We will file the K1 import declaration in your name. Please confirm the details we have on file:
- Name: ${name}
- MyKad No.: ${genMyKad(r)}
- Contact No.: ${genMyPhone(r)}

Estimated import duty and sales tax: ${D.amount(r, "MYR", 150, 2500)}. Storage is free until ${day(3, 7)}.
Container: ${D.container(r)}

Regards,
${r.pick(N.my)}
${r.pick(B.myForwarder)}
Tel: ${genMyPhone(r, "landline", "3")}`);
}

function enPermit(r) {
  const name = r.pick(N.my);
  return doc("en", "permit_email", "MY", T`Subject: Cosmetic product notification received

Dear ${name},

We have received the NPRA notification for "Aloe lip balm 4 g" submitted by ${r.pick(B.myShop)} on ${D.date(r, "en")}.
Applicant details on record:
Name: ${name}
IC No.: ${genMyKad(r)}
Phone: ${genMyPhone(r)}

Processing fee paid: ${D.amount(r, "MYR", 50, 50)}
Notification No.: ${D.npraNotification(r)}
Print this number on the product label once the notification is approved.`);
}

function enNotice(r) {
  const { bank, value } = genMyBank(r);
  return doc("en", "marketplace_notice", "MY", T`Seller Centre notice

Hi ${r.pick(B.myShop)},
We could not verify your payout details. Please check that they match your identity document.
Registered name: ${r.pick(N.my)}
MyKad: ${genMyKad(r)}
Bank: ${bank}, account ${value}
Payouts for orders ${D.orderId(r, "shopee")} and ${D.orderId(r, "shopee")} (${D.amount(r, "MYR", 80, 900)}) are on hold until ${D.date(r, "en")}.
If you did not make this change, contact us. Registered phone: ${D.masked(r, "phone")}`);
}

function enChat(r) {
  const t = clock(r);
  const [fa, fb] = [firstName(r.pick(N.my)), firstName(r.pick(N.cnEn))];
  const p = r.pick(PRODUCTS);
  const { bank, value } = genMyBank(r);
  return doc("en", "chat", "MY", T`${t()} ${fa}: Hi ${fb}, I need ${qtyOf(r)} pcs of the ${p.en} by ${D.date(r, "en")}. Can ship to KL?
${t()} ${fb}: Yes can. The courier needs the receiver phone number
${t()} ${fa}: ${genMyPhone(r)}. Address: ${r.pick(P.my).addr}
${t()} ${fb}: Ok noted 👍 Total ${D.amount(r, "USD", 600, 5000)}. 30% deposit first please
${t()} ${fa}: Can I pay your Malaysia agent in ringgit?
${t()} ${fb}: Yes. ${bank} ${value}, name ${r.pick(N.my)}
${t()} ${fa}: Done, ${D.amount(r, "MYR", 800, 6000)} sent. Ref ${D.quoteNo(r)}`);
}

function enReceipt(r) {
  const contact = r.chance(0.5) ? T`\nQuestions about this payment? WhatsApp ${genMyPhone(r)}` : [];
  return doc("en", "receipt", "MY", T`Payment receipt
Paid to: ${r.pick(B.myPrinter)}
Budget line: Packaging
Amount: ${D.amount(r, "MYR", 200, 3000)}
Invoice: ${D.invoiceNo(r)}
On-chain record: ${D.txHash(r)}
Payer wallet: ${D.address(r)}
Settled on ${D.date(r, "en")}.${contact}`);
}

function enIdSupplierInvoice(r) {
  const p = r.pick(PRODUCTS);
  const place = r.pick(P.id);
  const qty = qtyOf(r);
  const usd = D.moneyFmt(r, "USD");
  const day = D.dateSeq(r, "en");
  const [goods, freight] = [qty * r.int(4, 14) * 50, r.int(120, 600) * 100];
  return doc("en", "invoice", "ID", T`INVOICE ${D.invoiceNo(r)}
${r.pick(B.idSupplier)}
NPWP: ${genNpwp(r, { company: true })}
${place.addr}
Phone: ${genIdPhone(r, "landline", place.area)}

Date: ${day()}
Buyer: ${r.pick(N.my)}, ${r.pick(B.myShop)}, Malaysia
Buyer phone: ${genMyPhone(r)}

${p.en} x ${qty} pcs: ${usd(goods)}
Freight to Port Klang: ${usd(freight)}
Total: ${usd(goods + freight)}
Payment due by ${day(14, 30)}.
Shipping contact: ${r.pick(N.id)}, ${genIdPhone(r)}`);
}

function enOrderSummary(r) {
  const [p1, p2, p3] = [r.pick(PRODUCTS), r.pick(PRODUCTS), r.pick(PRODUCTS)];
  const day = D.dateSeq(r, "en");
  return doc("en", "order_summary", "MY", T`Weekly order summary - ${r.pick(B.myShop)}
Order ${D.orderId(r, "shopee")}: 2 x ${p1.en}, ${D.amount(r, "MYR", 30, 120)}, shipped ${day()}, tracking ${D.tracking(r)}
Order ${D.orderId(r, "lazada")}: 1 x ${p2.en}, ${D.amount(r, "MYR", 20, 80)}, shipped ${day(0, 2)}, tracking ${D.tracking(r)}
Order ${D.orderId(r, "tiktok")}: 3 x ${p3.en}, ${D.amount(r, "MYR", 40, 150)}, awaiting pickup
Payout ${D.invoiceNo(r, "PO")} of ${D.amount(r, "MYR", 300, 2000)} sent to the account ending ${D.masked(r, "account")}.
Sea freight forwarder: ${r.pick(B.sgForwarder)} (UEN ${D.uen(r)})
Next stock arrival: container ${D.container(r)}, HS ${D.hsCode(r, p1.hs)}`);
}

// ---- Malay ----------------------------------------------------------------------------------------
function msInvoice(r) {
  const seller = r.pick(B.myPrinter);
  const place = r.pick(P.my);
  const { bank, value } = genMyBank(r);
  const qty = qtyOf(r);
  const rm = D.moneyFmt(r, "MYR");
  const day = D.dateSeq(r, "ms");
  const [box, card, ship] = [qty * r.int(90, 180), qty * r.int(10, 30), r.int(15, 60) * 100];
  return doc("ms", "invoice", "MY", T`INVOIS ${D.invoiceNo(r)}
${seller}
No. Pendaftaran Syarikat: ${D.ssm(r)}
${place.addr}
Tel: ${genMyPhone(r, "landline", place.area)}

Tarikh: ${day()}
Kepada: ${r.pick(N.my)}
No. Tel: ${genMyPhone(r)}

Kotak pos bercetak, ${qty} unit: ${rm(box)}
Kad terima kasih, ${qty} unit: ${rm(card)}
Penghantaran: ${rm(ship)}
Jumlah perlu dibayar: ${rm(box + card + ship)}

Sila bayar ke ${bank}, No. Akaun: ${value}
atas nama ${seller} sebelum ${day(7, 30)}.`);
}

function msCustoms(r) {
  const name = r.pick(N.my);
  const p = r.pick(PRODUCTS);
  return doc("ms", "customs_email", "MY", T`Perkara: Pengisytiharan kastam bagi B/L ${D.billOfLading(r)}

Salam ${name},

Kiriman ${qtyOf(r)} unit ${p.ms} (Kod HS ${D.hsCode(r, p.hs)}) telah tiba di Pelabuhan Klang pada ${D.date(r, "ms")}.
Untuk Borang K1, sila sahkan maklumat berikut:
Nama: ${name}
No. Kad Pengenalan: ${genMyKad(r)}
No. Telefon: ${genMyPhone(r)}

Anggaran duti import dan cukai jualan: ${D.amount(r, "MYR", 150, 2500)}.
No. kontena: ${D.container(r)}

Terima kasih,
${r.pick(N.my)}
${r.pick(B.myForwarder)}`);
}

function msPermit(r) {
  const name = r.pick(N.my);
  return doc("ms", "permit_email", "MY", T`Perkara: Notifikasi produk kosmetik diterima

Tuan/Puan ${name},

Notifikasi NPRA bagi "Krim tangan aloe 50 ml" oleh ${r.pick(B.myShop)} telah diterima pada ${D.date(r, "ms")}.
Butiran pemohon dalam rekod:
Nama: ${name}
No. Kad Pengenalan: ${genMyKad(r)}
No. Telefon: ${genMyPhone(r)}

Fi pemprosesan: ${D.amount(r, "MYR", 50, 50)}
No. Notifikasi: ${D.npraNotification(r)}
Cetak nombor ini pada label produk selepas notifikasi diluluskan.`);
}

function msChat(r) {
  const a = r.pick(N.my);
  const b = "Khidmat Pelanggan";
  const { bank, value } = genMyBank(r);
  return doc("ms", "chat", "MY", T`${firstName(a)}: Assalamualaikum, parcel saya belum sampai. Order ${D.orderId(r, "shopee")}
${b}: Waalaikumussalam 😊 Boleh bagi nombor telefon penerima?
${firstName(a)}: ${genMyPhone(r)}
${b}: Baik, kurier akan hubungi. Kalau nak refund, bagi nama bank dan nombor akaun ya
${firstName(a)}: ${bank} ${value} atas nama ${a}
${b}: Terima kasih. Refund ${D.amount(r, "MYR", 20, 200)} akan masuk dalam 3 hingga 5 hari bekerja`);
}

function msNotice(r) {
  const { bank, value } = genMyBank(r);
  return doc("ms", "marketplace_notice", "MY", T`Notis Pusat Penjual

Hai ${r.pick(B.myShop)},
Kami perlu mengesahkan identiti anda sebelum bayaran seterusnya.
Nama berdaftar: ${r.pick(N.my)}
No. MyKad: ${genMyKad(r)}
Akaun bank: ${bank} ${value}
Pesanan ${D.orderId(r, "shopee")} dan ${D.orderId(r, "lazada")} (jumlah ${D.amount(r, "MYR", 80, 900)}) ditahan sehingga ${D.date(r, "ms")}.
Jika anda tidak membuat perubahan ini, hubungi kami. Telefon berdaftar: ${D.masked(r, "phone")}`);
}

function msQuote(r) {
  const p = r.pick(PRODUCTS);
  const qty = qtyOf(r);
  const rm = D.moneyFmt(r, "MYR");
  const unit = r.int(8, 40) * 50;
  return doc("ms", "quote", "MY", T`SEBUT HARGA ${D.quoteNo(r)}
${r.pick(B.myWholesale)}
No. Syarikat: ${D.ssm(r)}
Tarikh: ${D.date(r, "ms")}
Untuk: ${r.pick(N.my)}, ${r.pick(B.myShop)}

${p.ms}, ${qty} unit x ${rm(unit)} = ${rm(unit * qty)}
Kod HS (rujukan import): ${D.hsCode(r, p.hs)}
Sah selama 14 hari.
Hubungi ${r.pick(N.my)}: ${genMyPhone(r)}`);
}

function msReceipt(r) {
  return doc("ms", "receipt", "MY", T`Resit bayaran
Dibayar kepada: ${r.pick(B.myPrinter)} (${D.ssm(r)})
Jumlah: ${D.amount(r, "MYR", 200, 3000)}
Rujukan invois: ${D.invoiceNo(r)}
Rekod on-chain: ${D.txHash(r)}
Dompet pembayar: ${D.address(r)}
Tarikh: ${D.date(r, "ms")}`);
}

// ---- Indonesian -----------------------------------------------------------------------------------
function idFaktur(r) {
  const p = r.pick(PRODUCTS);
  const place = r.pick(P.id);
  const qty = qtyOf(r);
  const rp = D.moneyFmt(r, "IDR");
  const day = D.dateSeq(r, "id");
  const goods = qty * r.int(15, 80) * 100000;
  const vat = Math.round((goods * 0.11) / 100000) * 100000;
  return doc("id", "invoice", "ID", T`FAKTUR ${D.invoiceNo(r)}
${r.pick(B.idSupplier)}
NPWP: ${genNpwp(r, { company: true })}
${place.addr}
Telp: ${genIdPhone(r, "landline", place.area)}

Tanggal: ${day()}
Kepada: ${r.pick(N.id)}
NIK: ${genNik(r)}
HP: ${genIdPhone(r)}

${p.id} x ${qty} pcs: ${rp(goods)}
PPN: ${rp(vat)}
Total: ${rp(goods + vat)}
Jatuh tempo: ${day(14, 30)}`);
}

function idChat(r) {
  const a = r.pick(N.id);
  const fa = firstName(a);
  const b = "Admin";
  const p = r.pick(PRODUCTS);
  const rp = D.moneyFmt(r, "IDR");
  const npwp = r.chance(0.6) ? T`\n${fa}: Fakturnya pakai NPWP toko ya: ${genNpwp(r, { company: true })}` : [];
  const nik = r.chance(0.85) ? T`\n${b}: Kalau mau daftar reseller, kirim NIK sesuai KTP ya kak\n${fa}: ${genNik(r)}` : [];
  return doc("id", "chat", "ID", T`${fa}: Kak, mau pesan ${p.id} ${qtyOf(r)} pcs ya
${b}: Siap kak 🙏 Untuk pengiriman, nama dan nomor HP penerima?
${fa}: ${a}, ${genIdPhone(r)}
${b}: Alamatnya kak?
${fa}: ${r.pick(P.id).addr}
${b}: Ok. Total ${rp(r.int(10, 90) * 10000000)} + ongkir ${rp(r.int(2, 9) * 1000000)}. Pesanan ${D.orderId(r, "tokopedia")}${npwp}${nik}`);
}

function idCustoms(r) {
  const p = r.pick(PRODUCTS);
  return doc("id", "customs_email", "ID", T`Subjek: Dokumen impor untuk B/L ${D.billOfLading(r)}

Yth. Bapak/Ibu ${r.pick(N.id)},

Barang Anda (${p.id}, HS ${D.hsCode(r, p.hs)}) tiba di Tanjung Priok pada ${D.date(r, "id")}.
Untuk pengajuan PIB, mohon konfirmasi data berikut:
NIK: ${genNik(r)}
NPWP: ${genNpwp(r)}
No. HP: ${genIdPhone(r)}

Perkiraan bea masuk dan PPN impor: ${D.amount(r, "IDR", 2000000, 40000000)}
No. kontainer: ${D.container(r)}

Salam,
${r.pick(N.id)}
${r.pick(B.idForwarder)} | Telp ${genIdPhone(r, "landline", "21")}`);
}

function idNotice(r) {
  return doc("id", "marketplace_notice", "ID", T`Pemberitahuan Seller Center

Halo ${r.pick(B.idShop)},
Verifikasi data toko Anda belum selesai. Pastikan data berikut sesuai KTP:
Nama: ${r.pick(N.id)}
NIK: ${genNik(r)}
No. HP terdaftar: ${genIdPhone(r)}
Pesanan ${D.orderId(r, "tokopedia")} dan ${D.orderId(r, "tokopedia")} senilai ${D.amount(r, "IDR", 150000, 5000000)} ditahan hingga ${D.date(r, "id")}.
Abaikan pesan ini jika data Anda sudah lengkap.`);
}

function idQuote(r) {
  const p = r.pick(PRODUCTS);
  const qty = qtyOf(r);
  const usd = D.moneyFmt(r, "USD");
  const unit = r.int(3, 12) * 50;
  return doc("id", "quote", "ID", T`PENAWARAN HARGA ${D.quoteNo(r)}
${r.pick(B.idSupplier)}, NPWP ${genNpwp(r, { company: true })}
Kepada: ${r.pick(N.my)} (${r.pick(B.myShop)}), Malaysia, WA ${genMyPhone(r)}

Produk: ${p.id}, ${qty} pcs
Harga: ${usd(unit)}/pcs, total ${usd(unit * qty)}
Kode HS: ${D.hsCode(r, p.hs)}
Berlaku sampai ${D.date(r, "id")}.
Kontak kami: ${r.pick(N.id)}, ${genIdPhone(r)}`);
}

function idOrderSummary(r) {
  const [p1, p2] = [r.pick(PRODUCTS), r.pick(PRODUCTS)];
  return doc("id", "order_summary", "ID", T`Ringkasan pesanan ${r.pick(B.idShop)}
${D.orderId(r, "tokopedia")} - ${qtyOf(r)} pcs ${p1.id} - ${D.amount(r, "IDR", 500000, 9000000)} - dikirim ${D.date(r, "id")}, resi ${D.tracking(r, "ID")}
${D.orderId(r, "shopee")} - ${qtyOf(r)} pcs ${p2.id} - ${D.amount(r, "IDR", 500000, 9000000)} - menunggu pickup
Pencairan dana ${D.amount(r, "IDR", 1000000, 20000000)} ke rekening berakhiran ${D.masked(r, "account")}.
Stok berikutnya: kontainer ${D.container(r)}, HS ${D.hsCode(r, p1.hs)}.`);
}

// ---- Chinese --------------------------------------------------------------------------------------
function zhQuote(r) {
  const p = r.pick(PRODUCTS);
  const qty = qtyOf(r);
  const usd = D.moneyFmt(r, "USD");
  const day = D.dateSeq(r, "zh");
  const unit = r.int(3, 12) * 50;
  return doc("zh", "quote", "MY", T`报价单 编号：${D.quoteNo(r)}
日期：${day()}
供应商：${r.pick(B.cnZh)}
业务联系人：${r.pick(N.cnZh)}
客户：${r.pick(N.myZh)}（马来西亚 ${r.pick(B.myShop)}）
客户电话：${genMyPhone(r)}

产品：${p.zh}，起订量 ${qty} 个
海关编码：${D.hsCode(r, p.hs)}
单价：${usd(unit)}（FOB ${r.pick(P.cnPortZh)}）
合计：${usd(unit * qty)}
交期：收到定金后 ${r.int(15, 35)} 天
报价有效期至 ${day(14, 30)}。`);
}

function zhChat(r) {
  const a = r.pick(N.myZh);
  const b = "集运客服";
  const { bank, value } = genMyBank(r);
  return doc("zh", "chat", "MY", T`${a}：老板，我的货到了吗？单号 ${D.tracking(r)}
${b}：到了，明天派送。收件人电话多少？
${a}：${genMyPhone(r)}
${b}：好的👌 清关需要收件人的IC号码
${a}：${genMyKad(r)}
${b}：运费 ${D.amount(r, "MYR", 30, 400)}，转账到我们公司户口就可以：${bank} ${value}
${a}：收到，谢谢老板`);
}

function zhNotice(r) {
  const { bank, value } = genMyBank(r);
  return doc("zh", "marketplace_notice", "MY", T`卖家中心通知
${r.pick(B.myShop)} 您好：
您的收款资料尚未通过验证，请确认以下信息与身份证件一致。
登记姓名：${r.pick(N.myZh)}
身份证号码（MyKad）：${genMyKad(r)}
收款银行户口：${bank} ${value}
订单 ${D.orderId(r, "shopee")} 和 ${D.orderId(r, "shopee")}（共 ${D.amount(r, "MYR", 80, 900)}）的款项暂缓至 ${D.date(r, "zh")}。
如非本人操作，请联系客服。`);
}

function zhInvoice(r) {
  const p = r.pick(PRODUCTS);
  const place = r.pick(P.my);
  const qty = qtyOf(r);
  const { bank, value } = genMyBank(r);
  const rm = D.moneyFmt(r, "MYR");
  const [goods, ship] = [qty * r.int(4, 30) * 50, r.int(15, 80) * 100];
  return doc("zh", "invoice", "MY", T`发票 ${D.invoiceNo(r)}
${r.pick(B.myWholesale)}（公司注册号：${D.ssm(r)}）
地址：${place.addr}
电话：${genMyPhone(r, "landline", place.area)}

客户：${r.pick(N.myZh)}，手机：${genMyPhone(r)}
品名：${p.zh} × ${qty} = ${rm(goods)}
运费：${rm(ship)}
总计：${rm(goods + ship)}
请汇款至 ${bank} 户口 ${value}，并注明发票号码。`);
}

function zhQuoteToId(r) {
  const p = r.pick(PRODUCTS);
  const qty = qtyOf(r);
  const usd = D.moneyFmt(r, "USD");
  const unit = r.int(3, 12) * 50;
  return doc("zh", "quote", "ID", T`报价单 ${D.quoteNo(r)}
供应商：${r.pick(B.cnZh)}
客户：${r.pick(N.id)}（印度尼西亚 ${r.pick(B.idSupplier)}）
税号 NPWP：${genNpwp(r, { company: true })}
联系电话：${genIdPhone(r)}
产品：${p.zh} ${qty} 个，单价 ${usd(unit)}，合计 ${usd(unit * qty)}
海关编码：${D.hsCode(r, p.hs)}
清关资料：收货人 NIK ${genNik(r)}`);
}

function zhArrival(r) {
  const p = r.pick(PRODUCTS);
  const day = D.dateSeq(r, "zh");
  return doc("zh", "customs_email", "MY", T`到货通知
柜号：${D.container(r)}，提单号：${D.billOfLading(r)}
货物：${p.zh}，海关编码 ${D.hsCode(r, p.hs)}
件数：${r.int(20, 300)} 箱，毛重 ${r.int(200, 4000)} 公斤
预计关税及销售税：${D.amount(r, "MYR", 150, 2500)}
到港日期：${day()}，免仓期至 ${day(3, 7)}
订单号：${D.orderId(r, "tiktok")}
链上付款记录：${D.txHash(r)}`);
}

/** Template name → [function, document count]. Counts sum to 150 (en 53, ms 39, id 33, zh 25). */
export const MAIN_PLAN = {
  enQuote: [enQuote, 8],
  enInvoice: [enInvoice, 8],
  enCustoms: [enCustoms, 4],
  enPermit: [enPermit, 3],
  enNotice: [enNotice, 6],
  enChat: [enChat, 7],
  enReceipt: [enReceipt, 6],
  enIdSupplierInvoice: [enIdSupplierInvoice, 6],
  enOrderSummary: [enOrderSummary, 5],
  msInvoice: [msInvoice, 7],
  msCustoms: [msCustoms, 6],
  msPermit: [msPermit, 3],
  msChat: [msChat, 7],
  msNotice: [msNotice, 6],
  msQuote: [msQuote, 6],
  msReceipt: [msReceipt, 4],
  idFaktur: [idFaktur, 7],
  idChat: [idChat, 7],
  idCustoms: [idCustoms, 6],
  idNotice: [idNotice, 5],
  idQuote: [idQuote, 5],
  idOrderSummary: [idOrderSummary, 3],
  zhQuote: [zhQuote, 6],
  zhChat: [zhChat, 6],
  zhNotice: [zhNotice, 4],
  zhInvoice: [zhInvoice, 4],
  zhQuoteToId: [zhQuoteToId, 4],
  zhArrival: [zhArrival, 1],
};
