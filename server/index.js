require("dotenv").config();
const path = require("path");
const express = require("express");
const { fetchVacancyText } = require("./hhParser");
const { structureVacancy, generateCoverParts, matchRequirements, generateIntro } = require("./llm");
const { searchCandidates } = require("./hhSearch");

const app = express();
const PORT = process.env.PORT || 3000;

// Сколько подходящих вакансий (прошедших и локальные фильтры, и % соответствия) нужно найти,
// прежде чем остановить подбор — см. requirements.md, /new. Вакансии обрабатываются по одной;
// как только наберётся столько — поиск останавливается, даже если хватило не всех просмотренных.
const TARGET_QUALIFIED = 5;
// Защитный предел на число вакансий, которые вообще просматриваются через LLM за один подбор
// (структурирование + сопоставление) — на случай, если TARGET_QUALIFIED никогда не наберётся
// из-за слишком строгих фильтров/порога. Без него поиск мог бы не останавливаться очень долго.
const MAX_SCANNED = 60;
// Пауза между вакансиями на шаге 4 (запрос страницы вакансии на hh.ru + LLM) — не долбить
// hh.ru и LLM-провайдеров подряд без пауз, как DELAY в 1_parse.py.
const CANDIDATE_DELAY_MS = 1500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/new", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "new.html"));
});

app.post("/api/parse-vacancy", async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Не передана ссылка на вакансию." });
  }
  console.log(`[usage] Обработать: ${url}`);

  try {
    const vacancyText = await fetchVacancyText(url);
    const structured = await structureVacancy(vacancyText);
    res.json(structured);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/generate-cover", async (req, res) => {
  const { requirements, company, tasks, bonuses, theses } = req.body || {};
  if (!Array.isArray(requirements) || !Array.isArray(theses)) {
    return res.status(400).json({ error: "Неверный формат данных: requirements и theses должны быть массивами." });
  }
  console.log(`[usage] Сгенерировать сопроводительное: ${requirements.length} требований, ${theses.length} тезисов`);

  try {
    const result = await generateCoverParts({ requirements, company, tasks, bonuses, theses });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/search-vacancies", async (req, res) => {
  const body = req.body || {};
  const searchPhrase = typeof body.searchPhrase === "string" ? body.searchPhrase.trim() : "";
  const theses = Array.isArray(body.theses) ? body.theses.filter((t) => typeof t === "string" && t.trim()) : [];
  const matchThreshold = Number(body.matchThreshold);

  if (!searchPhrase) {
    return res.status(400).json({ error: "Не заполнена поисковая фраза." });
  }
  if (!Number.isFinite(matchThreshold) || matchThreshold < 0 || matchThreshold > 100) {
    return res.status(400).json({ error: "Некорректное значение «% соответствия опыта требованиям» (0–100)." });
  }

  const parseList = (v) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
  const professionalRoleIds = parseList(body.professionalRoleIds);
  const areaIds = parseList(body.areaIds);
  const stopWords = parseList(body.stopWords);
  const stopProfessions = parseList(body.stopProfessions);
  const days = body.days ? parseInt(body.days, 10) : null;
  const minSalaryRub =
    body.minSalaryRub !== null && body.minSalaryRub !== undefined && body.minSalaryRub !== ""
      ? Number(body.minSalaryRub)
      : null;
  const workFormat = ["REMOTE", "REMOTE_HYBRID"].includes(body.workFormat) ? body.workFormat : "ANY";

  console.log(`[usage] Подобрать вакансии: "${searchPhrase}", порог соответствия ${matchThreshold}%`);

  // Потоковый ответ (NDJSON — одна JSON-строка на событие): подбор может занимать больше
  // времени, чем готов ждать прокси/хостинг без активности на соединении (на Railway это
  // приводило к обрыву с "upstream error"), плюс фронтенд теперь показывает вакансии по мере
  // нахождения, а не одним пакетом в конце. Типы событий: "vacancy" (найдена подходящая
  // вакансия), "progress" (обновление счётчиков для спиннера), "done" (подбор завершён),
  // "error" (подбор прерван ошибкой).
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  });
  const send = (event) => res.write(JSON.stringify(event) + "\n");

  let scanned = 0;
  let found = 0;
  try {
    const candidates = searchCandidates({
      professionalRoleIds,
      searchPhrase,
      areaIds,
      workFormat,
      days,
      stopWords,
      stopProfessions,
      minSalaryRub,
      maxScanned: MAX_SCANNED,
    });

    for await (const candidate of candidates) {
      scanned++;
      try {
        const vacancyText = await fetchVacancyText(candidate.url);
        const structured = await structureVacancy(vacancyText);
        const match = await matchRequirements({ requirements: structured.requirements, theses });

        const total = structured.requirements.length;
        const matchedCount = match.requirements_status.filter((s) => s.matched).length;
        const percent = total ? Math.round((matchedCount / total) * 100) : 100;

        if (percent >= matchThreshold) {
          found++;
          send({
            type: "vacancy",
            vacancy: {
              id: candidate.id,
              url: candidate.url,
              title: candidate.title,
              companyName: candidate.companyName,
              areaName: candidate.areaName,
              salaryDisplay: candidate.salaryDisplay,
              company: structured.company,
              tasks: structured.tasks,
              bonuses: structured.bonuses,
              requirements: structured.requirements,
              requirements_status: match.requirements_status,
              matched_thesis_indices: match.matched_thesis_indices,
              matchPercent: percent,
            },
          });
        }
      } catch (err) {
        console.error(`[подбор вакансий] Пропущена вакансия ${candidate.url}: ${err.message}`);
      }

      send({ type: "progress", scanned, found });
      if (found >= TARGET_QUALIFIED) break;
      await sleep(CANDIDATE_DELAY_MS);
    }
  } catch (err) {
    console.error(`[подбор вакансий] Подбор прерван ошибкой: ${err.message}`);
    send({ type: "error", message: err.message });
  }

  send({ type: "done", scanned, found });
  res.end();
});

app.post("/api/generate-intro", async (req, res) => {
  const { company, tasks, bonuses, theses, matched_thesis_indices } = req.body || {};
  if (
    typeof company !== "string" ||
    typeof tasks !== "string" ||
    typeof bonuses !== "string" ||
    !Array.isArray(theses) ||
    !Array.isArray(matched_thesis_indices)
  ) {
    return res.status(400).json({ error: "Неверный формат данных." });
  }
  console.log(`[usage] Сгенерировать сопроводительное (/new)`);

  try {
    const result = await generateIntro({ company, tasks, bonuses, theses, matchedThesisIndices: matched_thesis_indices });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
});
