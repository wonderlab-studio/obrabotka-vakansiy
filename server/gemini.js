const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_MODEL_LITE = process.env.GEMINI_MODEL_LITE || "gemini-2.5-flash-lite";
const API_KEY = process.env.GEMINI_API_KEY;

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.1";

// Облачная Ollama (https://ollama.com) — тот же нативный API (/api/generate), что и локальная,
// но по адресу ollama.com и с Bearer-токеном; модели там называются с суффиксом "-cloud"
// (например "gpt-oss:120b-cloud"), см. https://docs.ollama.com/cloud.
const OLLAMA_CLOUD_URL = process.env.OLLAMA_CLOUD_URL || "https://ollama.com";
const OLLAMA_CLOUD_API_KEY = process.env.OLLAMA_CLOUD_API_KEY;
const OLLAMA_CLOUD_MODEL = process.env.OLLAMA_CLOUD_MODEL || "gpt-oss:120b-cloud";

// Таймауты на отдельный вызов, чтобы зависший провайдер не блокировал всю цепочку фолбэков.
const GEMINI_TIMEOUT_MS = 20000;
const OLLAMA_CLOUD_TIMEOUT_MS = 30000;
const OLLAMA_TIMEOUT_MS = 60000; // локальная генерация на CPU может быть заметно медленнее

// Статусы, при которых стоит переключиться на следующую модель в цепочке фолбэков
// (квота исчерпана / модель перегружена), а не считать это фатальной ошибкой промпта.
const FALLBACK_STATUSES = new Set([429, 503]);

// Квота Gemini на бесплатном тарифе — дневная. Если модель уже вернула 429 в рамках текущего
// запуска сервера, повторный сетевой запрос к ней почти наверняка снова упрётся в 429 и просто
// потратит время — поэтому запоминаем это и пропускаем модель без обращения к сети.
const EXHAUSTION_TTL_MS = 6 * 60 * 60 * 1000; // 6 часов
const exhaustedUntil = new Map();

function isExhausted(model) {
  const until = exhaustedUntil.get(model);
  return typeof until === "number" && Date.now() < until;
}

function markExhausted(model) {
  exhaustedUntil.set(model, Date.now() + EXHAUSTION_TTL_MS);
}

class LlmHttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function callGeminiModel(model, prompt) {
  if (!API_KEY) {
    throw new Error("GEMINI_API_KEY не задан. Добавьте ключ в .env (см. .env.example).");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`;
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json" },
  });

  let res;
  try {
    res = await fetchWithTimeout(
      url,
      { method: "POST", headers: { "Content-Type": "application/json" }, body },
      GEMINI_TIMEOUT_MS
    );
  } catch (err) {
    // Сетевая ошибка или таймаут — считаем провайдера временно недоступным, чтобы цепочка
    // фолбэков перешла к следующей модели, а не падала целиком.
    throw new LlmHttpError(`Gemini (${model}) не ответил за ${GEMINI_TIMEOUT_MS}мс: ${err.message}`, 503);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new LlmHttpError(`Gemini (${model}) вернул ошибку ${res.status}: ${errText.slice(0, 500)}`, res.status);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error(`Gemini (${model}) вернул пустой ответ.`);
  }
  return text;
}

async function callOllamaApi({ baseUrl, model, apiKey, timeoutMs, prompt, label }) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let res;
  try {
    res = await fetchWithTimeout(
      `${baseUrl}/api/generate`,
      { method: "POST", headers, body: JSON.stringify({ model, prompt, format: "json", stream: false }) },
      timeoutMs
    );
  } catch (err) {
    throw new Error(`Не удалось получить ответ от ${label} (${baseUrl}) за ${timeoutMs}мс: ${err.message}.`);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`${label} (${model}) вернул ошибку ${res.status}: ${errText.slice(0, 500)}`);
  }

  const data = await res.json();
  if (!data.response) {
    throw new Error(`${label} вернул пустой ответ.`);
  }
  return data.response;
}

async function callOllamaCloud(prompt) {
  if (!OLLAMA_CLOUD_API_KEY) {
    throw new Error(
      "OLLAMA_CLOUD_API_KEY не задан. Создайте ключ на https://ollama.com/settings/keys и добавьте в .env " +
        "(см. .env.example), либо этот шаг цепочки будет пропущен."
    );
  }
  return callOllamaApi({
    baseUrl: OLLAMA_CLOUD_URL,
    model: OLLAMA_CLOUD_MODEL,
    apiKey: OLLAMA_CLOUD_API_KEY,
    timeoutMs: OLLAMA_CLOUD_TIMEOUT_MS,
    prompt,
    label: "облачная Ollama",
  });
}

async function callOllamaLocal(prompt) {
  try {
    return await callOllamaApi({
      baseUrl: OLLAMA_URL,
      model: OLLAMA_MODEL,
      apiKey: undefined,
      timeoutMs: OLLAMA_TIMEOUT_MS,
      prompt,
      label: "локальная Ollama",
    });
  } catch (err) {
    throw new Error(
      `${err.message} Убедитесь, что Ollama запущен ("ollama serve") и модель ${OLLAMA_MODEL} загружена ` +
        `("ollama pull ${OLLAMA_MODEL}").`
    );
  }
}

// Цепочка фолбэков: основная модель Gemini → лёгкая модель Gemini → облачная Ollama →
// локальная Ollama. Для Gemini переключение только при 429 (квота)/503 (перегрузка) или
// таймауте — на других ошибках (например, невалидный промпт) сразу возвращаем ошибку, не
// маскируя баг переходом на другую модель. Внутренних повторов для одной и той же модели
// больше нет: они только удлиняли ответ, а переход к следующему провайдеру и так даёт
// частичный эффект повтора, только быстрее.
// Облачная и локальная Ollama — это уже офлайн-резерв последней надежды, поэтому для них любая
// ошибка (в т.ч. отсутствие ключа/недоступность) просто переходит к следующему шагу цепочки.
async function callLLM(prompt) {
  const errors = [];

  for (const model of [GEMINI_MODEL, GEMINI_MODEL_LITE]) {
    if (isExhausted(model)) {
      errors.push(`${model}: пропущен — недавно вернул 429 (квота исчерпана)`);
      continue;
    }
    try {
      return JSON.parse(await callGeminiModel(model, prompt));
    } catch (err) {
      if (!(err instanceof LlmHttpError) || !FALLBACK_STATUSES.has(err.status)) throw err;
      if (err.status === 429) markExhausted(model);
      errors.push(err.message);
    }
  }

  try {
    return JSON.parse(await callOllamaCloud(prompt));
  } catch (err) {
    errors.push(err.message);
  }

  try {
    return JSON.parse(await callOllamaLocal(prompt));
  } catch (err) {
    errors.push(err.message);
    throw new Error("Все LLM-провайдеры недоступны:\n" + errors.join("\n"));
  }
}

// Промпт из requirements.md, раздел 5.5.1
function buildStructurePrompt(vacancyText) {
  return `Из HTML-текста вакансии извлеки четыре блока данных за один проход: описание компании,
описание задач будущего сотрудника, список требований, описание бонусов и плюшек для
сотрудников.

"Компания" - одно предложение, самое ключевое о компании.
"Задачи" - одно предложение, ключевая роль сотрудника.
"Требования" - массив требований, желательные и бонусные требования с приставкой "(плюс)".
"Бонусы" - через запятую, привлекательные условия (ДМС, курсы английского, гибкий график
и т.п.).

Ответ верни строго в формате JSON, без пояснений и без markdown-обрамления (без \`\`\`),
по следующей схеме:

{
  "company": "string — одно предложение о компании",
  "tasks": "string — одно предложение о задачах сотрудника",
  "requirements": ["string", "..."],
  "bonuses": "string — плюшки через запятую"
}

Текст вакансии:
"""
${vacancyText}
"""`;
}

// Промпт из requirements.md, раздел 5.5.2
// Тезисы в письмо не переписываются LLM текстом обратно — модель возвращает только номера
// подошедших тезисов (индексы во входном массиве theses), а дословный текст для письма
// backend берёт напрямую из исходного массива. Так исключается перефразирование текста
// тезисов моделью (наблюдалось на практике даже при явном запрете в промпте).
function buildGeneratePrompt(inputJson) {
  return `Исходя из описания компании, задач сотрудника и бонусов напиши вступление сопроводительного
письма — почему соискатель хочет работать именно в этой компании. Вступление должно быть
одним коротким предложением, без воды и без лишних оборотов. Пример: "Меня заинтересовала
позиция Middle Python-разработчика в «Волна Технологии» — близок ваш продукт в финтехе и
упор на высоконагруженные сервисы."

Далее посмотри список требований (массив requirements, нумерация с 0) и список тезисов опыта
(массив theses, нумерация с 0), найди соответствия. Требование и тезис считаются
соответствующими, только если в обоих встречается одно и то же (или синонимичное)
существительное, глагол или аббревиатура, называющие конкретный навык, технологию, тип
артефакта или деятельность — общие слова вроде "проект", "работа", "опыт" не считаются.
Аббревиатуры на разных языках для одного и того же артефакта — совпадение (например "ФТ" и
"FR" — функциональные требования). Пример НЕсовпадения: "разработка архитектурного проекта"
и "управление проектами разработки маркетплейсов" — общее только слово "проект". Пример
совпадения: "разработка прототипов" и "прототипирование в Figma" — общий корень "прототип".

По этому правилу пометь требования, для которых нашёлся хотя бы один подходящий тезис, как
"выполненные", остальные как "невыполненные". Отдельно собери номера ВСЕХ тезисов, которые
подошли хотя бы под одно требование, — ни один подходящий тезис не должен быть пропущен,
каждый номер указывается только один раз, даже если тезис подходит под несколько требований.

Ответ верни строго в формате JSON, без пояснений и без markdown-обрамления (без \`\`\`),
по следующей схеме:

{
  "intro": "string — вступление сопроводительного письма",
  "matched_thesis_indices": [0, 2],
  "requirements_status": [
    { "requirement": "string — точный текст требования из входного массива", "matched": true }
  ]
}

Исходные данные:
"""
${JSON.stringify(inputJson)}
"""`;
}

async function structureVacancy(vacancyText) {
  const result = await callLLM(buildStructurePrompt(vacancyText));
  if (
    typeof result.company !== "string" ||
    typeof result.tasks !== "string" ||
    typeof result.bonuses !== "string" ||
    !Array.isArray(result.requirements)
  ) {
    throw new Error("Ответ LLM не соответствует ожидаемой схеме (company/tasks/requirements/bonuses).");
  }
  return result;
}

async function generateCoverParts({ requirements, company, tasks, bonuses, theses }) {
  const inputJson = { requirements, company, tasks, bonuses, theses };
  const result = await callLLM(buildGeneratePrompt(inputJson));
  if (
    typeof result.intro !== "string" ||
    !Array.isArray(result.matched_thesis_indices) ||
    !Array.isArray(result.requirements_status)
  ) {
    throw new Error("Ответ LLM не соответствует ожидаемой схеме (intro/matched_thesis_indices/requirements_status).");
  }

  // Дословный текст тезисов берём из исходного массива по индексам от LLM — так письмо
  // никогда не содержит перефразированный моделью текст (см. комментарий у buildGeneratePrompt).
  const experiencePart = result.matched_thesis_indices
    .filter((i) => Number.isInteger(i) && i >= 0 && i < theses.length)
    .map((i) => theses[i])
    .join("\n");

  return { intro: result.intro, experience_part: experiencePart, requirements_status: result.requirements_status };
}

module.exports = { structureVacancy, generateCoverParts };
