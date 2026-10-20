/**
 * Invented names, businesses, places and products for E5 documents. None is a real person; business
 * names are made up for this dataset. Bank and marketplace names are real brands, used only as the
 * context a founder's documents would carry (no real account numbers: every number is generated).
 */
export const NAMES = {
  my: ["Nurul Aina Rosli", "Ahmad Faizal Hassan", "Siti Hajar Kamarudin", "Lim Wei Ling", "Tan Kok Wah", "Priya Ramasamy", "Kavitha Subramaniam", "Mohd Hafiz Zulkifli", "Chong Hui Min", "Farah Izzati Azman", "Wong Jun Hao", "Aisyah Rahman", "Daniel Ong Chee Keong", "Rajesh Kumar Muthu", "Hazwani Ismail", "Goh Siew Lan", "Amirul Hakim Yusri", "Yap Li Xuan", "Shalini Devi Nair", "Izzat Firdaus Roslan"],
  myZh: ["林慧玲", "陈俊豪", "黄淑芬", "张伟强", "郑佩珊", "吴家明", "李佩仪", "刘志伟"],
  id: ["Rizky Pratama", "Ayu Wulandari", "Fajar Nugroho", "Sri Rahayu", "Agus Setiawan", "Putri Anggraini", "Hendra Wijaya", "Nur Fadilah", "Yoga Saputra", "Indah Permatasari", "Bayu Kurniawan", "Wulan Sari"],
  cnZh: ["周文斌", "吴海燕", "郑晓东", "孙佳怡", "何建平", "许丽娟"],
  cnEn: ["Kevin Zhou", "Lily Wu", "Jason Zheng", "Cindy Sun", "Eric He", "Amy Xu"],
  sg: ["Tan Hui Ling", "Muhammad Irfan Salleh", "Lim Jia Wei", "Nur Aqilah Rahim", "Rachel Koh", "Darren Teo", "Kumar Selvam", "Charmaine Lee", "Ong Kai Xiang", "Farhana Yusof"],
  sgMs: ["Muhammad Irfan Salleh", "Nur Aqilah Rahim", "Farhana Yusof", "Hafiz Rahmat", "Siti Zulaikha Osman"],
  sgZh: ["陈慧敏", "林志诚", "黄佳琪", "王俊杰"],
};

export const FIRST = (full) => full.split(" ")[0];

export const BUSINESSES = {
  myPrinter: ["Cetak Jaya Packaging Sdn. Bhd.", "Kotak Emas Enterprise", "Pek Sin Printing Sdn. Bhd.", "Teratai Box & Label Sdn. Bhd."],
  myForwarder: ["Lautan Biru Freight Sdn. Bhd.", "Sinar Logistik Sdn. Bhd.", "Selat Cargo Services Sdn. Bhd."],
  myWholesale: ["Bukit Indah Supplies", "Teratai Wholesale Sdn. Bhd.", "Kedai Borong Seri Maju"],
  myShop: ["Aina Living", "KopiCup Studio", "Warisan Home", "Cawan Cantik", "Rumah Kemas", "Dapur Ceria"],
  cnEn: ["Yongkang Brightcup Drinkware Co., Ltd.", "Ningbo Seastar Household Products Co., Ltd.", "Yiwu Pinecone Packaging Co., Ltd.", "Shantou Clearleaf Plastic Co., Ltd."],
  cnZh: ["永康市明杯日用品有限公司", "宁波海星家居用品有限公司", "义乌松果包装有限公司", "汕头清叶塑料制品有限公司"],
  idSupplier: ["CV Sinar Abadi", "PT Mitra Kemasan Nusantara", "CV Gelas Jaya", "PT Sumber Rejeki Plastindo", "CV Kriya Bambu Lestari"],
  idForwarder: ["PT Bintang Cargo Indonesia", "PT Samudra Kirim Logistik"],
  idShop: ["Toko Rumah Rapi", "Dapur Mungil", "Gelasku Official", "Serba Wadah"],
  sgPrinter: ["Lion City Prints Pte. Ltd.", "Kallang Packaging Pte. Ltd.", "Tampines Box Co. Pte. Ltd."],
  sgForwarder: ["Harbourline Forwarding Pte. Ltd.", "Straits Gateway Logistics Pte. Ltd."],
  sgShop: ["Sip & Co.", "Little Kopi Corner", "Homebound SG", "Brew Buddy"],
};

/** Street-level only (no house or unit numbers); `area` is the landline area code that goes with it. */
export const PLACES = {
  my: [
    { addr: "Jalan Ampang, 50450 Kuala Lumpur", area: "3" },
    { addr: "Taman Molek, 81100 Johor Bahru", area: "7" },
    { addr: "Bayan Lepas, 11900 Pulau Pinang", area: "4" },
    { addr: "Seksyen 13, 40100 Shah Alam", area: "3" },
    { addr: "Taman Tasik, 31400 Ipoh", area: "5" },
    { addr: "Jalan Song, 93350 Kuching", area: "82" },
    { addr: "Jalan Lintas, 88300 Kota Kinabalu", area: "88" },
  ],
  id: [
    { addr: "Jl. Raya Bogor, Jakarta Timur", area: "21" },
    { addr: "Jl. Diponegoro, Surabaya", area: "31" },
    { addr: "Jl. Asia Afrika, Bandung", area: "22" },
    { addr: "Jl. Gajah Mada, Semarang", area: "24" },
    { addr: "Jl. Kaliurang, Sleman, Yogyakarta", area: "274" },
    { addr: "Jl. Teuku Umar, Denpasar", area: "361" },
    { addr: "Jl. Pettarani, Makassar", area: "411" },
    { addr: "Jl. Gatot Subroto, Medan", area: "61" },
  ],
  sg: ["Tampines Street 41", "Toa Payoh Lorong 4", "Ubi Crescent", "Jurong East Street 21", "Woodlands Avenue 6"],
  cnPortEn: ["Ningbo", "Shenzhen (Yantian)", "Xiamen", "Guangzhou (Nansha)"],
  cnPortZh: ["宁波", "深圳盐田", "厦门", "广州南沙"],
};

/** One product in each language with its HS heading (tumblers and flasks 9617.00, steel 7323.93, ...). */
export const PRODUCTS = [
  { en: "500 ml insulated tumbler", ms: "tumbler bertebat 500 ml", id: "tumbler stainless 500 ml", zh: "500毫升保温杯", hs: "9617.00" },
  { en: "stainless steel water bottle", ms: "botol air keluli tahan karat", id: "botol minum stainless", zh: "不锈钢水瓶", hs: "7323.93" },
  { en: "ceramic coffee mug", ms: "mug seramik", id: "mug keramik", zh: "陶瓷马克杯", hs: "6912.00" },
  { en: "glass storage jar with bamboo lid", ms: "balang kaca penutup buluh", id: "toples kaca tutup bambu", zh: "竹盖玻璃储物罐", hs: "7013.99" },
  { en: "collapsible silicone cup", ms: "cawan silikon boleh lipat", id: "gelas silikon lipat", zh: "折叠硅胶杯", hs: "3924.10" },
];
