const cheerio = require("cheerio");

const HH_URL_RE = /^https:\/\/([a-z]+\.)?hh\.ru\/vacancy\/\d+/i;

function isValidHhUrl(url) {
  return HH_URL_RE.test(url);
}

async function fetchVacancyText(url) {
  if (!isValidHhUrl(url)) {
    throw new Error("Ссылка должна вести на страницу вакансии hh.ru (https://hh.ru/vacancy/...).");
  }

  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (!res.ok) {
    throw new Error(`Не удалось загрузить страницу вакансии (HTTP ${res.status}).`);
  }

  const html = await res.text();
  const $ = cheerio.load(html);

  const title = $('[data-qa="vacancy-title"]').first().text().trim();
  const description = $('[data-qa="vacancy-description"]').first().text().trim();
  const skills = $('[data-qa="skills-element"]')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(Boolean);

  if (!description) {
    throw new Error(
      "Не удалось найти описание вакансии на странице. Возможно, hh.ru изменил разметку " +
        "страницы или заблокировал запрос (антибот-защита) — попробуйте ещё раз или проверьте " +
        "ссылку вручную."
    );
  }

  const parts = [];
  if (title) parts.push(`Название вакансии: ${title}`);
  parts.push(description);
  if (skills.length) parts.push(`Ключевые навыки: ${skills.join(", ")}`);

  return parts.join("\n\n");
}

module.exports = { fetchVacancyText, isValidHhUrl };
