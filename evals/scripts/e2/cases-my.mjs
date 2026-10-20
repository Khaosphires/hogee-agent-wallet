// The 16 Malaysia prompts (P1 Q4). Same shape as cases-sg.mjs.
//
// Labelling scope (evals/docs/evals-e2.md): MY.json carries productApprovals for drinkware only, so MY prompts
// sell drinkware (pack: NONE) or apparel (LABELING §3.6: NONE, no fee). Cosmetics (NPRA), electrical (ST_SIRIM) and
// food (KKM_FOOD) need a fee leaf the pack lacks; Singapore prompts cover those categories. Only drinkware is bought
// from China, because the pack models the Form E rate for the tumbler line alone. Apparel is made or bought locally.

const base = { partner: false, limitedLiability: false, productCount: 1, sellChannel: 'shopee', horizonDays: 60 };
const t = (over) => ({ ...base, ...over });
const DRINK = 'drinkware_food_contact';

export const MY_CASES = [
  {
    key: 'rina-main',
    lang: 'en',
    truth: t({ residency: 'citizen', productCategory: DRINK, buyFrom: 'CN', budgetMinor: '1000000' }),
    text: () =>
      "Hi, I'm Rina from Penang. I want to sell custom insulated tumblers on Shopee Malaysia. I'm a Malaysian citizen doing this on my own, buying the tumblers from a factory in China. My budget is RM10,000.",
  },
  {
    key: 'malay-tumblers-no-residency',
    lang: 'ms',
    hiddenSlot: 'residency',
    truth: t({ residency: 'citizen', productCategory: DRINK, buyFrom: 'CN', budgetMinor: '800000' }),
    text: ({ budget }) => `Saya nak jual tumbler keluli tahan karat di Shopee, ambil stok dari kilang di China. Bajet ${budget}. Saya buat sorang je.`,
    answer: () => 'Saya warganegara Malaysia.',
  },
  {
    key: 'kids-bottles-no-residency',
    lang: 'en',
    hiddenSlot: 'residency',
    truth: t({ residency: 'foreigner', productCategory: DRINK, buyFrom: 'CN', budgetMinor: '500000', sellChannel: 'tiktok_shop' }),
    text: ({ budget }) =>
      `I want to sell kids' water bottles with straw lids on TikTok Shop Malaysia, bought from a supplier in China. I have around ${budget} and I'm doing it alone.`,
    answer: () => "I'm Indonesian, working in Malaysia on a work permit.",
  },
  {
    key: 'zh-mixed-cousins-mugs',
    lang: 'en',
    zh: true,
    truth: t({ residency: 'citizen', partner: true, productCategory: DRINK, buyFrom: 'CN', budgetMinor: '1200000' }),
    text: () => '我和我 cousin 想一起 partnership 在 Shopee Malaysia 卖 ceramic mugs, 从中国景德镇进货. We are both Malaysian citizens. Budget RM12k.',
  },
  {
    key: 'pr-us-flasks',
    lang: 'en',
    truth: t({ residency: 'pr', productCategory: DRINK, buyFrom: 'US', budgetMinor: '1500000', sellChannel: 'lazada' }),
    text: ({ budget }) =>
      `I'm a Malaysian permanent resident. I'd like to sell premium vacuum flasks on Lazada Malaysia, imported from a distributor in the United States. Solo business, budget ${budget}.`,
  },
  {
    key: 'malay-local-bottles-no-budget',
    lang: 'ms',
    hiddenSlot: 'budgetCeilingMinor',
    truth: t({ residency: 'citizen', productCategory: DRINK, buyFrom: 'MY', budgetMinor: '300000' }),
    text: () => 'Saya warganegara Malaysia, nak jual botol air dan tumbler di Shopee. Stok saya beli dari pemborong di Kuala Lumpur. Saya seorang diri.',
    answer: ({ budget }) => budget,
  },
  {
    key: 'singaporean-in-jb-tumblers',
    lang: 'en',
    truth: t({ residency: 'foreigner', productCategory: DRINK, buyFrom: 'CN', budgetMinor: '2000000' }),
    text: ({ budget }) =>
      `I'm a Singaporean living in Johor Bahru. I'd like to sell insulated tumblers on Shopee Malaysia, sourced from a factory in Zhejiang, China. Budget ${budget}, just me.`,
  },
  {
    key: 'malay-sdn-bhd-investor',
    lang: 'ms',
    truth: t({ residency: 'citizen', limitedLiability: true, productCategory: DRINK, buyFrom: 'CN', budgetMinor: '3000000', sellChannel: 'own_site', horizonDays: 90 }),
    text: ({ budget }) =>
      `Saya warganegara Malaysia. Saya nak tubuhkan Sdn Bhd sebab nak liabiliti terhad, dan ada pelabur yang nak ambil saham. Saya akan jual botol air kaca di laman web sendiri, stok dari kilang di China. Modal ${budget} untuk tiga bulan pertama.`,
  },
  {
    key: 'manglish-no-product',
    lang: 'en',
    hiddenSlot: 'productCategory',
    truth: t({ residency: 'citizen', productCategory: DRINK, buyFrom: 'CN', budgetMinor: '600000' }),
    text: ({ budget }) => `Hi, I'm Malaysian lah, wanna open a Shopee shop with one product line first, stock from China. Budget ${budget}. Just me. What do I need to do?`,
    answer: () => 'Insulated tumblers.',
  },
  {
    key: 'pr-tumblers-no-origin',
    lang: 'en',
    hiddenSlot: 'buyFrom',
    truth: t({ residency: 'pr', productCategory: DRINK, buyFrom: 'CN', budgetMinor: '900000' }),
    text: ({ budget }) => `I'm a Malaysian PR and I want to sell double-wall tumblers on Shopee. Budget ${budget}, doing it solo.`,
    answer: () => 'From China, a factory in Yongkang.',
  },
  {
    key: 'malay-baju-kurung-local',
    lang: 'ms',
    truth: t({ residency: 'citizen', productCategory: 'apparel', buyFrom: 'MY', budgetMinor: '400000' }),
    text: ({ budget }) => `Saya warganegara Malaysia. Saya nak jual baju kurung di Shopee, dijahit oleh tukang jahit tempatan di Kelantan. Bajet ${budget}, saya buat seorang.`,
  },
  {
    key: 'malay-friends-no-product',
    lang: 'ms',
    hiddenSlot: 'productCategory',
    truth: t({ residency: 'citizen', partner: true, productCategory: 'apparel', buyFrom: 'MY', budgetMinor: '700000', sellChannel: 'tiktok_shop' }),
    text: ({ budget }) =>
      `Saya dan kawan baik saya, kedua-duanya warganegara Malaysia, nak buka perniagaan perkongsian di TikTok Shop. Stok dari pembekal tempatan di Malaysia. Modal ${budget}.`,
    answer: () => 'Tudung bawal kain kapas.',
  },
  {
    key: 'foreigner-batik-own-site',
    lang: 'en',
    truth: t({ residency: 'foreigner', productCategory: 'apparel', buyFrom: 'MY', budgetMinor: '1000000', sellChannel: 'own_site' }),
    text: ({ budget }) =>
      `I'm a Japanese national living in Kuala Lumpur. I want to sell batik shirts made by small workshops in Kelantan through my own website. Budget about ${budget}, just me.`,
  },
  {
    key: 'zh-mixed-kidswear-no-origin',
    lang: 'en',
    zh: true,
    hiddenSlot: 'buyFrom',
    truth: t({ residency: 'citizen', productCategory: 'apparel', buyFrom: 'MY', budgetMinor: '500000' }),
    text: () => "我是马来西亚公民, want to sell 童装 kids' clothes on Shopee. Budget RM5k, 一个人做.",
    answer: () => '从 KL Jalan TAR 的批发商拿货, local supplier in Malaysia.',
  },
  {
    key: 'glass-tumblers-no-residency',
    lang: 'en',
    hiddenSlot: 'residency',
    truth: t({ residency: 'pr', productCategory: DRINK, buyFrom: 'CN', budgetMinor: '650000', sellChannel: 'lazada' }),
    text: ({ budget }) => `I want to sell glass tumblers with bamboo lids on Lazada Malaysia, ordered from a factory in China. Budget ${budget}, running it alone.`,
    answer: () => "I'm a Malaysian PR, the red IC.",
  },
  {
    key: 'modest-sportswear-local',
    lang: 'en',
    truth: t({ residency: 'citizen', productCategory: 'apparel', buyFrom: 'MY', budgetMinor: '1500000', sellChannel: 'tiktok_shop' }),
    text: ({ budget }) => `Malaysian citizen here. I want to sell modest sportswear on TikTok Shop, made by a garment factory in Batu Pahat, Johor. Solo, budget ${budget}.`,
  },
];
