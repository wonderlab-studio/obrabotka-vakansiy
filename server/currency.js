// Перевод зарплат в рубли по курсу ЦБ РФ (шаг 2 пайплайна подбора вакансий, /new).
// Бесплатный источник без ключа, ежедневный курс — см. requirements.md, раздел про /new.

const CBR_URL = "https://www.cbr-xml-daily.ru/daily_json.js";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 час

let cache = null; // { fetchedAt, rates: Map<string, number> } — rates: рублей за 1 единицу валюты

async function getRates() {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.rates;

  const res = await fetch(CBR_URL);
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
}

function normalizeCurrencyCode(code) {
  // hh.ru использует устаревший код "RUR" для российского рубля.
  return code === "RUR" ? "RUB" : code;
}

// Возвращает сумму в рублях (округлённую) или null, если валюта неизвестна ЦБ РФ.
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
