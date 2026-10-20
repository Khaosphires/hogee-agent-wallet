// The 24 Singapore prompts (P1 Q4). Each case is one founder: what they type (`text`), the plan-changing facts
// (`truth`, LABELING §2.3) and, for a vague prompt, the slot the text leaves out and how the founder answers when asked.
// `text` and `answer` receive the budget as the founder writes it ({ budget }, chosen from the seeded stream).
// zh: the text mixes in Chinese, as Singapore founders often write; the frozen `lang` enum has no zh, so it is "en".
//
// Labelling scope (evals/docs/evals-e2.md): every SG approval binds the importer, so a regulated category is
// always imported; only apparel is bought locally (EXEMPT). Cosmetics are "other" cosmetics (HSA's SGD 13 tier, not
// eye, lip or hair dye) and electrical goods are SAFETY Mark controlled goods; each names a single product.

const base = { partner: false, limitedLiability: false, productCount: 1, sellChannel: 'shopee', horizonDays: 60 };
const t = (over) => ({ ...base, ...over });
const DRINK = 'drinkware_food_contact';

export const SG_CASES = [
  {
    key: 'mei-main',
    lang: 'en',
    truth: t({ residency: 'citizen', productCategory: DRINK, buyFrom: 'CN', budgetMinor: '1000000' }),
    text: () =>
      "Hi, I'm Mei. I want to sell custom insulated tumblers on Shopee Singapore. I'm a Singapore citizen running this on my own, and I'll buy the tumblers from a factory in China. My budget is S$10,000.",
  },
  {
    key: 'engraved-tumblers-no-budget',
    lang: 'en',
    hiddenSlot: 'budgetCeilingMinor',
    truth: t({ residency: 'citizen', productCategory: DRINK, buyFrom: 'CN', budgetMinor: '600000' }),
    text: () =>
      "I want to sell insulated tumblers on Shopee SG, the laser-engraved kind people buy as gifts. I'm Singaporean, doing it solo, and I'll source them from suppliers in Yiwu, China. Not sure yet how much money to put in. What would the plan look like?",
    answer: ({ budget }) => budget,
  },
  {
    key: 'singlish-tiktok-tumblers',
    lang: 'en',
    hiddenSlot: 'residency',
    truth: t({ residency: 'pr', productCategory: DRINK, buyFrom: 'CN', budgetMinor: '450000', sellChannel: 'tiktok_shop' }),
    text: ({ budget }) =>
      `Ok so I wanna start selling stainless steel tumblers on TikTok Shop SG lah. Will get them from a China factory, budget around ${budget}. Just me alone running it, no partner.`,
    answer: () => "I'm a Singapore PR.",
  },
  {
    key: 'sisters-mugs-partnership',
    lang: 'en',
    truth: t({ residency: 'pr', partner: true, productCategory: DRINK, buyFrom: 'CN', budgetMinor: '800000' }),
    text: ({ budget }) =>
      `My sister and I are both Singapore PRs and want to run a small partnership selling ceramic coffee mugs on Shopee Singapore. We'd import the mugs from Jingdezhen in China. Together we can put in ${budget}.`,
  },
  {
    key: 'foreigner-kids-bottles',
    lang: 'en',
    truth: t({ residency: 'foreigner', productCategory: DRINK, buyFrom: 'CN', budgetMinor: '500000' }),
    text: ({ budget }) =>
      `I'm a Malaysian citizen working in Singapore, not a PR. On the side I want to sell kids' water bottles with straw lids on Shopee Singapore, ordered from a factory in Guangdong, China. Budget ${budget}, and it's only me.`,
  },
  {
    key: 'investor-flasks-pte-ltd',
    lang: 'en',
    truth: t({ residency: 'citizen', limitedLiability: true, productCategory: DRINK, buyFrom: 'CN', budgetMinor: '2000000', sellChannel: 'own_site', horizonDays: 90 }),
    text: ({ budget }) =>
      `I'm a Singapore citizen launching my own brand of vacuum flasks, sold on my own website. A family friend wants to invest and hold shares, so I want a private limited company with limited liability rather than a sole proprietorship. The flasks will come from a manufacturer in Zhejiang, China. Starting budget ${budget} for the first three months.`,
  },
  {
    key: 'zh-mixed-no-product',
    lang: 'en',
    zh: true,
    hiddenSlot: 'productCategory',
    truth: t({ residency: 'citizen', productCategory: DRINK, buyFrom: 'CN', budgetMinor: '700000' }),
    text: () => 'Hi, 我是新加坡 citizen, 想在 Shopee 开一间小店, 货 from Yiwu China, budget 大概 S$7,000. 我一个人做, 没有 partner. 需要准备什么?',
    answer: () => '卖保温杯, the insulated tumbler kind.',
  },
  {
    key: 'malay-tudung-no-origin',
    lang: 'ms',
    hiddenSlot: 'buyFrom',
    truth: t({ residency: 'citizen', productCategory: 'apparel', buyFrom: 'CN', budgetMinor: '300000' }),
    text: ({ budget }) => `Saya warganegara Singapura dan nak jual tudung dan selendang di Shopee Singapore. Bajet saya ${budget}. Saya uruskan seorang diri.`,
    answer: () => 'Saya ambil stok dari kilang di Guangzhou, China.',
  },
  {
    key: 'malay-couple-baju-raya-local',
    lang: 'ms',
    truth: t({ residency: 'citizen', partner: true, productCategory: 'apparel', buyFrom: 'SG', budgetMinor: '250000', sellChannel: 'tiktok_shop' }),
    text: ({ budget }) =>
      `Saya dan suami, kedua-duanya warganegara Singapura, nak buka perniagaan perkongsian jual baju raya di TikTok Shop. Stok kami beli daripada pemborong tempatan di Singapura. Modal kami ${budget}.`,
  },
  {
    key: 'korean-serum',
    lang: 'en',
    truth: t({ residency: 'citizen', productCategory: 'cosmetics', buyFrom: 'KR', budgetMinor: '600000' }),
    text: ({ budget }) =>
      `Singapore citizen here. I'd like to start with one product, a vitamin C face serum from a Korean manufacturer, sold on Shopee Singapore. I'll import it from Korea myself. Working solo, budget ${budget}.`,
  },
  {
    key: 'sunscreen-own-site-no-residency',
    lang: 'en',
    hiddenSlot: 'residency',
    truth: t({ residency: 'foreigner', productCategory: 'cosmetics', buyFrom: 'KR', budgetMinor: '500000', sellChannel: 'own_site' }),
    text: ({ budget }) =>
      `I'm planning to sell a Korean sunscreen, a single SKU to start, through my own online store in Singapore. I'd import it directly from a lab in Seoul. Budget is ${budget} and it's a one-person business.`,
    answer: () => "I'm a South Korean citizen living in Singapore, not a PR.",
  },
  {
    key: 'zh-mixed-lotion-pte-ltd',
    lang: 'en',
    zh: true,
    truth: t({ residency: 'pr', limitedLiability: true, productCategory: 'cosmetics', buyFrom: 'CN', budgetMinor: '1500000', sellChannel: 'lazada' }),
    text: () =>
      '我是新加坡 PR. I want to set up a Pte Ltd, 因为我想要 limited liability, 不想个人承担风险. Plan is to sell one rose body lotion 身体乳, made by a factory in Guangzhou China, on Lazada SG. Budget 大概 S$15,000.',
  },
  {
    key: 'own-brand-no-product',
    lang: 'en',
    hiddenSlot: 'productCategory',
    truth: t({ residency: 'citizen', productCategory: 'cosmetics', buyFrom: 'CN', budgetMinor: '900000' }),
    text: ({ budget }) => `I'm Singaporean and want to launch my own little brand on Shopee. A factory in China has already sent me a quote. Budget ${budget}, just me for now.`,
    answer: () => "It's one hand cream, a single product to start.",
  },
  {
    key: 'hair-dryer',
    lang: 'en',
    truth: t({ residency: 'citizen', productCategory: 'electrical', buyFrom: 'CN', budgetMinor: '1200000' }),
    text: ({ budget }) =>
      `I'm a Singapore citizen and want to sell one model of compact ionic hair dryer on Shopee Singapore, bought from a factory in Shenzhen, China. It's just me, and my budget is ${budget}.`,
  },
  {
    key: 'power-strip-no-origin',
    lang: 'en',
    hiddenSlot: 'buyFrom',
    truth: t({ residency: 'pr', productCategory: 'electrical', buyFrom: 'CN', budgetMinor: '750000', sellChannel: 'lazada' }),
    text: ({ budget }) => `I'm a Singapore PR. I want to sell one model of multi-plug power strip with USB ports on Lazada Singapore. About ${budget} to start, and I'm running it alone.`,
    answer: () => 'From a factory in Ningbo, China.',
  },
  {
    key: 'foreign-cofounders-steam-iron',
    lang: 'en',
    truth: t({ residency: 'foreigner', partner: true, productCategory: 'electrical', buyFrom: 'CN', budgetMinor: '1000000' }),
    text: ({ budget }) =>
      `My co-founder and I are both Indian nationals working in Singapore. We want to register as a partnership and sell one model of steam iron on Shopee Singapore, ordered from a manufacturer in Foshan, China. Combined budget ${budget}.`,
  },
  {
    key: 'singlish-hair-dryer-no-budget',
    lang: 'en',
    hiddenSlot: 'budgetCeilingMinor',
    truth: t({ residency: 'citizen', productCategory: 'electrical', buyFrom: 'CN', budgetMinor: '350000', sellChannel: 'tiktok_shop' }),
    text: () => 'Eh I am Singaporean, wanna sell one model of foldable travel hair dryer on TikTok Shop. Getting from a Guangdong factory in China. Doing it solo. How to start ah?',
    answer: ({ budget }) => budget,
  },
  {
    key: 'taiwan-pineapple-cakes',
    lang: 'en',
    truth: t({ residency: 'citizen', productCategory: 'food', buyFrom: 'TW', budgetMinor: '500000', horizonDays: 90 }),
    text: ({ budget }) =>
      `Singapore citizen here, working alone. I want to sell boxed pineapple cakes imported from a bakery in Taichung, Taiwan, on Shopee Singapore. Budget ${budget} for the first 3 months.`,
  },
  {
    key: 'zh-mixed-snacks-no-residency',
    lang: 'en',
    zh: true,
    hiddenSlot: 'residency',
    truth: t({ residency: 'foreigner', productCategory: 'food', buyFrom: 'CN', budgetMinor: '400000' }),
    text: () => 'Hello, 我想在 Shopee SG 卖中国的包装零食, like 辣条 and 瓜子, 从中国湖南的工厂进货. Budget 大概 S$4,000, 我一个人搞. 要注册什么?',
    answer: () => '我是马来西亚人, 在新加坡工作, 不是 PR.',
  },
  {
    key: 'japan-senbei-pte-ltd',
    lang: 'en',
    truth: t({ residency: 'pr', limitedLiability: true, productCategory: 'food', buyFrom: 'JP', budgetMinor: '1800000', sellChannel: 'own_site' }),
    text: ({ budget }) =>
      `I'm a Singapore PR. Two friends will invest as shareholders, so I'd like a private limited company. I'll sell Japanese rice crackers imported from a maker in Niigata, Japan, through my own website. Budget ${budget}.`,
  },
  {
    key: 'malay-no-product',
    lang: 'ms',
    hiddenSlot: 'productCategory',
    truth: t({ residency: 'citizen', productCategory: 'apparel', buyFrom: 'CN', budgetMinor: '500000' }),
    text: ({ budget }) => `Assalamualaikum, saya rakyat Singapura. Saya nak mula berniaga di Shopee, stok dari pembekal di China. Modal sekitar ${budget}. Saya buat seorang sahaja.`,
    answer: () => 'Baju kurung moden untuk wanita.',
  },
  {
    key: 'foreigner-printed-tees-local',
    lang: 'en',
    truth: t({ residency: 'foreigner', productCategory: 'apparel', buyFrom: 'SG', budgetMinor: '200000', sellChannel: 'own_site' }),
    text: ({ budget }) =>
      `I'm a Filipino citizen living in Singapore, not a PR. I want to sell custom-printed T-shirts through my own website, printed by a local print shop here in Singapore. Just me, budget ${budget}.`,
  },
  {
    key: 'athleisure-no-origin',
    lang: 'en',
    hiddenSlot: 'buyFrom',
    truth: t({ residency: 'citizen', productCategory: 'apparel', buyFrom: 'SG', budgetMinor: '800000' }),
    text: ({ budget }) => `I'm a Singapore citizen and want to sell women's athleisure leggings and sports bras on Shopee. Budget ${budget}, I'm doing it alone.`,
    answer: () => 'From a wholesaler here in Singapore, in Jalan Besar.',
  },
  {
    key: 'friends-us-bottles-no-budget',
    lang: 'en',
    hiddenSlot: 'budgetCeilingMinor',
    truth: t({ residency: 'citizen', partner: true, productCategory: DRINK, buyFrom: 'US', budgetMinor: '1200000', sellChannel: 'lazada' }),
    text: () =>
      'My best friend and I, both Singapore citizens, want to sell BPA-free sports water bottles on Lazada as a partnership. We would buy them from a distributor in the United States. How much should we budget?',
    answer: ({ budget }) => budget,
  },
];
