// Шаги 1–3 подбора вакансий (/new): поиск на hh.ru, перевод зарплат в рубли, локальная
// фильтрация по стоп-словам/стоп-профессиям/мин. з/п. Порт логики 1_parse.py (поиск и
// извлечение вакансий из HTML) и 9_filter.py (правила фильтрации) — рабочих отдельных
// скриптов в корне репозитория, — на Node.js, без сохранения промежуточных файлов.

const { toRub } = require("./currency");

const SEARCH_URL = "https://hh.ru/search/vacancy";
const ITEMS_ON_PAGE = 100;
const MAX_SEARCH_PAGES = 15; // защита от бесконечного пролистывания при слишком строгих фильтрах
const PAGE_DELAY_MS = 1500; // как DELAY в 1_parse.py — не долбить hh.ru запросами без пауз

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  Referer: "https://hh.ru/",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Декодирует HTML-сущности (hh.ru отдаёт встроенный JSON в экранированном виде, например
// &#34; вместо "). Аналог html.unescape из 1_parse.py.
const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeHtmlEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, ent) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[ent] !== undefined ? NAMED_ENTITIES[ent] : match;
  });
}

// Достаёт JSON-значение (объект/массив), идущее сразу после ключа "key": в тексте, балансируя
// скобки (аналог extract_vacancies из 1_parse.py, обобщённый на любой ключ).
function extractJsonAfterKey(text, key) {
  const marker = `"${key}":`;
  const start = text.indexOf(marker);
  if (start === -1) return undefined;

  let i = start + marker.length;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== "{" && text[i] !== "[") return undefined;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let j = i; j < text.length; j++) {
    const ch = text[j];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(i, j + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

// Аналог get_total_pages из 1_parse.py.
function getTotalPages(text) {
  let m = text.match(/"totalPages"\s*:\s*(\d+)/);
  if (m) return parseInt(m[1], 10);

  m = text.match(/"totalResults"\s*:\s*(\d+)/);
  if (m) {
    const total = parseInt(m[1], 10);
    return Math.max(1, Math.ceil(total / ITEMS_ON_PAGE));
  }
  return 1;
}

function buildSearchUrl({ professionalRoleIds, searchPhrase, areaIds, workFormat, days, page }) {
  const params = new URLSearchParams();
  params.append("text", searchPhrase);
  for (const id of professionalRoleIds) params.append("professional_role", id);
  for (const id of areaIds) params.append("area", id);
  if (days) params.append("search_period", String(days));
  if (workFormat === "REMOTE") {
    params.append("work_format", "REMOTE");
  } else if (workFormat === "REMOTE_HYBRID") {
    params.append("work_format", "REMOTE");
    params.append("work_format", "HYBRID");
  }
  params.append("items_on_page", String(ITEMS_ON_PAGE));
  params.append("page", String(page));
  return `${SEARCH_URL}?${params.toString()}`;
}

async function fetchSearchPage(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`hh.ru вернул ошибку ${res.status} при поиске вакансий.`);
  }
  return decodeHtmlEntities(await res.text());
}

// Дерево профессиональных ролей встроено в страницу поиска — используется, чтобы по
// professionalRoleIds вакансии получить читаемое название для фильтра «стоп-профессии».
function flattenRoleTree(tree) {
  const map = new Map();
  function walk(node) {
    if (!node) return;
    if (node.id !== undefined && node.text !== undefined) map.set(String(node.id), node.text);
    if (Array.isArray(node.items)) node.items.forEach(walk);
  }
  if (tree && Array.isArray(tree.items)) tree.items.forEach(walk);
  return map;
}

async function normalizeVacancy(raw) {
  const comp = raw.compensation || {};
  const salaryFrom = typeof comp.from === "number" ? comp.from : null;
  const salaryTo = typeof comp.to === "number" ? comp.to : null;
  const currencyCode = comp.currencyCode || null;

  const salaryFromRub = currencyCode ? await toRub(salaryFrom, currencyCode) : salaryFrom;
  const salaryToRub = currencyCode ? await toRub(salaryTo, currencyCode) : salaryTo;

  return {
    id: raw.vacancyId,
    url: (raw.links && raw.links.desktop) || `https://hh.ru/vacancy/${raw.vacancyId}`,
    title: raw.name || "",
    companyName: (raw.company && raw.company.name) || "",
    areaName: (raw.area && raw.area.name) || "",
    salaryFrom,
    salaryTo,
    currencyCode,
    salaryFromRub,
    salaryToRub,
    professionalRoleIds: (raw.professionalRoleIds || [])
      .flatMap((x) => x.professionalRoleId || [])
      .map(String),
  };
}

function formatSalary(vac) {
  if (vac.salaryFrom == null && vac.salaryTo == null) return "не указана";
  const code = vac.currencyCode === "RUR" ? "₽" : vac.currencyCode || "";
  const parts = [];
  if (vac.salaryFrom != null) parts.push(`от ${vac.salaryFrom.toLocaleString("ru-RU")}`);
  if (vac.salaryTo != null) parts.push(`до ${vac.salaryTo.toLocaleString("ru-RU")}`);
  let text = `${parts.join(" ")} ${code}`.trim();
  if (vac.currencyCode && vac.currencyCode !== "RUR" && (vac.salaryFromRub != null || vac.salaryToRub != null)) {
    const rubParts = [];
    if (vac.salaryFromRub != null) rubParts.push(`от ${vac.salaryFromRub.toLocaleString("ru-RU")}`);
    if (vac.salaryToRub != null) rubParts.push(`до ${vac.salaryToRub.toLocaleString("ru-RU")}`);
    text += ` (≈ ${rubParts.join(" ")} ₽)`;
  }
  return text;
}

function matchesStopList(text, stopList) {
  if (!stopList.length || !text) return false;
  const lower = text.toLowerCase();
  return stopList.some((term) => term && lower.includes(term.toLowerCase()));
}

// Порт условия min_salary из should_remove_row (9_filter.py) — сохранена та же логика
// «попадания» порога в диапазон вакансии, без изменений.
function violatesMinSalary(vac, minSalaryRub) {
  const from = vac.salaryFromRub;
  const to = vac.salaryToRub;
  if (from == null && to == null) return false;
  if (from != null && to != null) return !(from <= minSalaryRub && minSalaryRub <= to);
  if (from != null) return minSalaryRub < from;
  return minSalaryRub > to;
}

function passesLocalFilters(vac, { stopWords, stopProfessions, minSalaryRub, roleNames }) {
  if (matchesStopList(vac.title, stopWords)) return false;

  if (stopProfessions.length) {
    const roleText = vac.professionalRoleIds.map((id) => roleNames.get(id) || "").join(", ");
    if (matchesStopList(roleText, stopProfessions)) return false;
  }

  if (minSalaryRub != null && violatesMinSalary(vac, minSalaryRub)) return false;

  return true;
}

// Шаги 1–3, асинхронный генератор: ищет вакансии на hh.ru постранично, переводит зарплаты в
// рубли, фильтрует локально и отдаёт (yield) каждую подходящую вакансию сразу, по одной — не
// дожидаясь, пока наберётся какое-то фиксированное количество. Вызывающий код (server/index.js)
// сам решает, когда остановиться (обычно — когда набралось нужное число вакансий, прошедших
// уже LLM-сопоставление на шаге 4); при остановке через `break` в `for await` генератор
// корректно завершается. `maxScanned` — защитный предел на случай, если подходящих вакансий
// в принципе не наберётся (слишком строгие фильтры) — тогда генератор не сканирует бесконечно.
async function* searchCandidates({
  professionalRoleIds,
  searchPhrase,
  areaIds,
  workFormat,
  days,
  stopWords,
  stopProfessions,
  minSalaryRub,
  maxScanned,
}) {
  let roleNames = new Map();
  let totalPages = 1;
  let scanned = 0;

  for (let page = 0; page < MAX_SEARCH_PAGES && page < totalPages; page++) {
    if (page > 0) await sleep(PAGE_DELAY_MS);

    const url = buildSearchUrl({ professionalRoleIds, searchPhrase, areaIds, workFormat, days, page });
    const html = await fetchSearchPage(url);

    if (page === 0) {
      totalPages = getTotalPages(html);
      const tree = extractJsonAfterKey(html, "professionalRoleTree");
      if (tree) roleNames = flattenRoleTree(tree);
    }

    const rawVacancies = extractJsonAfterKey(html, "vacancies");
    if (!Array.isArray(rawVacancies) || !rawVacancies.length) continue;

    for (const raw of rawVacancies) {
      const vac = await normalizeVacancy(raw);
      if (!passesLocalFilters(vac, { stopWords, stopProfessions, minSalaryRub, roleNames })) continue;

      yield { ...vac, salaryDisplay: formatSalary(vac) };

      scanned++;
      if (scanned >= maxScanned) return;
    }
  }
}

module.exports = { searchCandidates };
