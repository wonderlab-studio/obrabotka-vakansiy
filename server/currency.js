// Перевод зарплат в рубли по курсу ЦБ РФ (шаг 2 пайплайна подбора вакансий, /new).
// Бесплатный источник без ключа, ежедневный курс — см. requirements.md, раздел про /new.

const CBR_URL = "https://www.cbr-xml-daily.ru/daily_json.js";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 час
const FETCH_TIMEOUT_MS = 5000;

let cache = null; // { fetchedAt, rates: Map<string, number> } — rates: рублей за 1 единицу валюты
let pendingFetch = null; // промис в процессе — чтобы параллельные вызовы toRub не били CBR одновременно

async function fetchRates() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(CBR_URL, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Не удалось получить курс валют ЦБ РФ (HTTP ${res.status}).`);
    }
    const data = await res.json();

    const rates = new Map();
    for (const valute of Object.values(data.Valute || {})) {
      rates.set(valute.CharCode, valute.Value / valute.Nominal);
    }
    cache = { fetchedAt: Date.now(), rates };
    return rates;
  } finally {
    clearTimeout(timer);
  }
}

// getRates() никогда не бросает исключение — курс валют не критичен для подбора вакансий
// (см. requirements.md, /new): если ЦБ РФ недоступен/не отвечает за FETCH_TIMEOUT_MS, зарплата
// в этой валюте просто остаётся неконвертированной (toRub вернёт null), а не валит весь подбор.
async function getRates() {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.rates;
  if (!pendingFetch) {
    pendingFetch = fetchRates().finally(() => {
      pendingFetch = null;
    });
  }
  try {
    return await pendingFetch;
  } catch (err) {
    console.error(`[currency] Курс ЦБ РФ недоступен: ${err.message}`);
    return new Map();
  }
}

function normalizeCurrencyCode(code) {
  // hh.ru использует устаревший код "RUR" для российского рубля.
  return code === "RUR" ? "RUB" : code;
}

// Возвращает сумму в рублях (округлённую) или null, если валюта неизвестна ЦБ РФ / курс
// сейчас недоступен — в этом случае вызывающий код просто не отсеивает вакансию по зарплате.
async function toRub(amount, currencyCode) {
  if (amount == null || !Number.isFinite(amount)) return null;
  const code = normalizeCurrencyCode(currencyCode);
  if (code === "RUB") return Math.round(amount);

  const rates = await getRates();
  const rate = rates.get(code);
  if (!rate) return null;
  return Math.round(amount * rate);
}

module.exports = { toRub };
