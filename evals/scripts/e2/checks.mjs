// Row checks the E2 generator runs on every case before writing, and that --check and the test run again. They keep
// LABELING §2.3 honest: a clear prompt states every plan-changing fact, a vague prompt hides exactly its hidden slot
// (nothing in the text gives it away), and the scripted answer gives the true value.

const CJK = /[㐀-鿿]/u;
const CURRENCY = /S\$|SGD|\bRM\s?\d|ringgit|新币|\$\d/iu;
const AMOUNT = /(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k|ribu)?/giu;

/** What would give away each hideable slot if it appeared in a vague prompt's text. */
const REVEALS = {
  residency: /citizen|\bPR\b|permanent resident|Singaporean|Malaysian|warganegara|rakyat|national|foreigner|work permit|公民|马来西亚人|新加坡人/iu,
  productCategory:
    /tumbler|bottle|mug|flask|\bcups?\b|serum|lotion|cream|sunscreen|skincare|dryer|\biron\b|power strip|snack|cake|cracker|shirt|tee|tudung|baju|legging|clothes|apparel|botol|杯|零食|童装|身体乳|衣/iu,
  buyFrom:
    /China|中国|Korea|Seoul|Japan|Taiwan|United States|Guangdong|Shenzhen|Yiwu|Zhejiang|Guangzhou|Ningbo|wholesaler|pemborong|pembekal|kilang|factory|supplier|manufacturer|import|tempatan|local|批发|工厂|进货/iu,
};

/** How the scripted answer must name the hidden value. */
const ANSWER_SAYS = {
  residency: {
    citizen: /citizen|warganegara/iu,
    pr: /\bPR\b|permanent resident/iu,
    foreigner: /not a PR|不是 PR|work permit|Indonesian/iu,
  },
  productCategory: {
    drinkware_food_contact: /tumbler|保温杯/iu,
    cosmetics: /cream|serum|lotion/iu,
    apparel: /baju|tudung/iu,
  },
  buyFrom: { CN: /China/iu, SG: /Singapore/iu, MY: /Malaysia/iu },
};

/** Every amount written in `text`, in whole currency units (S$4.5k → 4500, RM8 ribu → 8000). */
export function amountsIn(text) {
  return [...text.matchAll(AMOUNT)].map((m) => Number(m[1].replaceAll(',', '')) * (m[2] ? 1000 : 1));
}

const dollars = (minor) => Number(BigInt(minor) / 100n);

/** Problems with one built case (empty when it is sound). */
export function caseProblems({ promptId, country, lang, zh, hiddenSlot, text, answer, truth }) {
  const at = (msg) => `${promptId}: ${msg}`;
  const problems = [];
  if (text.length > 4000) problems.push(at('text longer than 4000'));
  if (Boolean(zh) !== CJK.test(text)) problems.push(at(`zh flag ${Boolean(zh)} but CJK in text is ${CJK.test(text)}`));
  if (!['en', 'ms'].includes(lang)) problems.push(at(`lang ${lang}`));
  if (!['SG', 'MY'].includes(country)) problems.push(at(`country ${country}`));
  const budget = dollars(truth.budgetMinor);
  if (hiddenSlot === 'budgetCeilingMinor') {
    if (CURRENCY.test(text)) problems.push(at('budget is hidden but the text names an amount'));
    if (!amountsIn(answer).includes(budget)) problems.push(at(`answer "${answer}" does not give the budget ${budget}`));
  } else if (!amountsIn(text).includes(budget)) {
    problems.push(at(`text does not state the budget ${budget}`));
  }
  if (hiddenSlot && hiddenSlot !== 'budgetCeilingMinor') {
    if (REVEALS[hiddenSlot].test(text)) problems.push(at(`${hiddenSlot} is hidden but the text gives it away (${text.match(REVEALS[hiddenSlot])[0]})`));
    const says = ANSWER_SAYS[hiddenSlot][truth[hiddenSlot]];
    if (!says) problems.push(at(`no answer check for ${hiddenSlot}=${truth[hiddenSlot]}`));
    else if (!says.test(answer)) problems.push(at(`answer "${answer}" does not give ${hiddenSlot}=${truth[hiddenSlot]}`));
  }
  if (!hiddenSlot && answer !== undefined) problems.push(at('a clear prompt has an answer'));
  return problems;
}
