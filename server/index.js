require("dotenv").config();
const path = require("path");
const express = require("express");
const { fetchVacancyText } = require("./hhParser");
const { structureVacancy, generateCoverParts } = require("./llm");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

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

app.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
});
