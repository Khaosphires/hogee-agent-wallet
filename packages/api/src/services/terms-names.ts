/**
 * TERMS_HOLDER_MISMATCH (VISION-DECISIONS §9): the payout account holder the founder typed must name a company (a
 * designator such as Ltd, Co, Pte, Sdn Bhd or 有限公司) and share a DISTINCTIVE name word with the seller name the
 * quarantined Reader grounded in the listing (suppliers.record_json.displayName). Designators, industry-generic words,
 * common sourcing place names and words under 4 letters never count as distinctive, so "Yongkang Other Drinkware Co.,
 * Ltd." does not match "Yongkang Corvane Drinkware Co., Ltd.". Pure; both names are compared after NFKC and lower-casing.
 *
 * Residual (documented for the audit): a listing that names the attacker's own company as the seller passes this check
 * by construction. The account still arrives only through the founder's form, is screened for sanctions, is shown in
 * the SupplierApproval the founder signs, and cools before any payment.
 */

const DESIGNATORS: ReadonlySet<string> = new Set([
  "ltd", "limited", "co", "company", "corp", "corporation", "inc", "incorporated", "pte", "sdn", "bhd", "berhad",
  "llc", "plc", "gmbh", "pty", "llp", "lp", "sa", "ag", "bv", "kk", "pt", "tbk",
]);

/** Han company suffixes, longest first. */
const HAN_DESIGNATORS = ["股份有限公司", "有限责任公司", "有限公司", "公司"] as const;

/** Words that say what a company does or where it is, not who it is. */
const GENERIC: ReadonlySet<string> = new Set([
  // industry words
  "trading", "traders", "industrial", "industries", "industry", "manufacturing", "manufacturer", "manufacture",
  "mfg", "factory", "products", "product", "technology", "technologies", "tech", "international", "intl", "global",
  "group", "holdings", "holding", "import", "export", "imp", "exp", "enterprise", "enterprises", "supply", "supplies",
  "supplier", "goods", "commodity", "commodities", "daily", "houseware", "housewares", "household", "home", "kitchen",
  "kitchenware", "drinkware", "cup", "cups", "bottle", "bottles", "packaging", "package", "printing", "logistics",
  "solutions", "services", "service", "development", "store", "shop", "official", "the", "and", "of", "for", "new",
  "best", "top", "good", "quality", "plastic", "plastics", "metal", "steel", "stainless", "craft", "crafts", "gift",
  "gifts", "art", "arts", "electronic", "electronics", "textile", "textiles", "garment", "garments", "bank", "account",
  // places
  "china", "chinese", "asia", "asian", "pacific", "hong", "kong", "hk", "malaysia", "singapore", "sg", "my", "prc",
  "yiwu", "yongkang", "ningbo", "shenzhen", "guangzhou", "dongguan", "foshan", "xiamen", "hangzhou", "shanghai",
  "beijing", "zhejiang", "guangdong", "fujian", "jiangsu", "shandong", "hebei", "jinhua", "wenzhou", "suzhou",
  "qingdao", "tianjin", "taizhou", "shantou", "zhongshan", "jieyang", "chaozhou", "nanjing", "wuhan", "chengdu",
  "hefei", "changzhou", "wuxi", "jiangmen", "huizhou", "quanzhou", "putian", "cixi", "yuyao", "shaoxing", "huzhou",
  "jiaxing", "kunshan", "kuala", "lumpur", "selangor", "johor", "penang",
]);

const HAN = /\p{Script=Han}/u;
/**
 * A non-Han word identifies a company only from this many letters on (run-9): shorter ones are common syllables and
 * words ("xin", "hua", "tai", "sun") that unrelated companies share.
 */
const MIN_DISTINCTIVE_LETTERS = 4;

function wordsOf(name: string): string[] {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t !== "");
}

/** A Han word without its company suffix (义乌晨光日用品有限公司 → 义乌晨光日用品), or null when it has none. */
function hanCore(word: string): { core: string; designated: boolean } {
  const suffix = HAN_DESIGNATORS.find((d) => word.endsWith(d));
  return suffix ? { core: word.slice(0, -suffix.length), designated: true } : { core: word, designated: false };
}

/** True when the name carries a company designator (Latin word or Han suffix). */
export function hasCompanyDesignator(name: string): boolean {
  return wordsOf(name).some((t) => DESIGNATORS.has(t) || (HAN.test(t) && hanCore(t).designated));
}

/** The words of a name that could identify the company: no designator, generic word, digits-only or short (< 4 letters) word. */
export function distinctiveWords(name: string): ReadonlySet<string> {
  const out = new Set<string>();
  for (const t of wordsOf(name)) {
    if (HAN.test(t)) {
      const { core } = hanCore(t);
      if ([...core].length >= 2) out.add(core);
      continue;
    }
    if ([...t].length < MIN_DISTINCTIVE_LETTERS || /^\p{N}+$/u.test(t) || DESIGNATORS.has(t) || GENERIC.has(t)) continue;
    out.add(t);
  }
  return out;
}

/** The holder names a company and shares at least one distinctive word with the seller name. */
export function holderMatchesSeller(holderName: string, sellerName: string): boolean {
  if (!hasCompanyDesignator(holderName)) return false;
  const seller = distinctiveWords(sellerName);
  return [...distinctiveWords(holderName)].some((t) => seller.has(t));
}
