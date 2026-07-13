// Фолбэк-цепочка LLM-провайдеров — см. requirements.md, раздел 5.6.
//
// Уровень A (гонка): Groq + Cerebras параллельно, резерв — Gemini.
// Уровень B: Mistral, резерв — Cohere.
// Уровень C: OpenRouter, резерв — GitHub Models.
// Финальный резерв: облачная Ollama.
//
// Для промпта 5.5.2 (сопоставление тезисов с требованиями) используется TIERS_MATCHING —
// та же цепочка, но без Groq в уровне A (см. комментарий у TIERS_MATCHING ниже).

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

const CEREBRAS_API_KEY = process.env.CEREBRAS_API_KEY;
const CEREBRAS_MODEL = process.env.CEREBRAS_MODEL || "gpt-oss-120b";

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const MISTRAL_MODEL = process.env.MISTRAL_MODEL || "mistral-small-latest";

const COHERE_API_KEY = process.env.COHERE_API_KEY;
const COHERE_MODEL = process.env.COHERE_MODEL || "command-r-plus";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-instruct:free";

const GITHUB_MODELS_TOKEN = process.env.GITHUB_MODELS_TOKEN;
const GITHUB_MODELS_MODEL = process.env.GITHUB_MODELS_MODEL || "openai/gpt-4o-mini";

// Облачная Ollama (https://ollama.com) — нативный API (/api/generate) по адресу ollama.com с
// Bearer-токеном; модели там называются с суффиксом "-cloud" (см. https://docs.ollama.com/cloud).
const OLLAMA_CLOUD_URL = process.env.OLLAMA_CLOUD_URL || "https://ollama.com";
const OLLAMA_CLOUD_API_KEY = process.env.OLLAMA_CLOUD_API_KEY;
const OLLAMA_CLOUD_MODEL = process.env.OLLAMA_CLOUD_MODEL || "gpt-oss:120b-cloud";

// Локальная Ollama отключена от цепочки (решение 2026-07-09, см. requirements.md 5.6) —
// при 7 бесплатных облачных резервах она стала избыточной и была самым медленным звеном.
// Функция вызова оставлена ниже на случай, если понадобится вернуть.
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.1";

const CLOUD_TIMEOUT_MS = 20000;
const OLLAMA_CLOUD_TIMEOUT_MS = 30000;
const OLLAMA_TIMEOUT_MS = 60000;

// TTL кэша «провайдер временно исчерпан» (см. requirements.md 5.6): если провайдер не прислал
// Retry-After, используем дефолт по типу лимита — дневная квота у Gemini (проверено на
// практике), у остальных вероятнее кратковременный RPM-лимит.
const DEFAULT_EXHAUSTION_TTL_MS = { gemini: 6 * 60 * 60 * 1000 };
const FALLBACK_EXHAUSTION_TTL_MS = 5 * 60 * 1000;

const exhaustedUntil = new Map();

function isExhausted(providerKey) {
  const until = exhaustedUntil.get(providerKey);
  return typeof until === "number" && Date.now() < until;
}

function markExhausted(providerKey, retryAfterSeconds) {
  const ttl =
    typeof retryAfterSeconds === "number" && retryAfterSeconds > 0
      ? retryAfterSeconds * 1000
      : DEFAULT_EXHAUSTION_TTL_MS[providerKey] || FALLBACK_EXHAUSTION_TTL_MS;
  exhaustedUntil.set(providerKey, Date.now() + ttl);
}

class LlmHttpError extends Error {
  constructor(message, status, retryAfterSeconds) {
    super(message);
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
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

function parseRetryAfter(res) {
  const header = res.headers.get("retry-after");
  const seconds = header ? Number(header) : NaN;
  return Number.isFinite(seconds) ? seconds : undefined;
}

function stripJsonFences(text) {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
}

async function callGeminiModel(prompt) {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY не задан.");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json" },
  });

  let res;
  try {
    res = await fetchWithTimeout(
      url,
      { method: "POST", headers: { "Content-Type": "application/json" }, body },
      CLOUD_TIMEOUT_MS
    );
  } catch (err) {
    throw new LlmHttpError(`Gemini (${GEMINI_MODEL}) не ответил за ${CLOUD_TIMEOUT_MS}мс: ${err.message}`, 503);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new LlmHttpError(
      `Gemini (${GEMINI_MODEL}) вернул ошибку ${res.status}: ${errText.slice(0, 500)}`,
      res.status,
      parseRetryAfter(res)
    );
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(`Gemini (${GEMINI_MODEL}) вернул пустой ответ.`);
  return text;
}

// Общий вызов для провайдеров с OpenAI-совместимым Chat Completions API
// (Groq, Cerebras, Mistral, Cohere compatibility-API, NVIDIA NIM, GitHub Models).
async function callOpenAiCompatible({ url, apiKey, model, prompt, label, jsonMode, timeoutMs, extraHeaders }) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...extraHeaders,
  };
  const body = {
    model,
    messages: [{ role: "user", content: prompt }],
  };
  if (jsonMode) body.response_format = { type: "json_object" };

  let res;
  try {
    res = await fetchWithTimeout(url, { method: "POST", headers, body: JSON.stringify(body) }, timeoutMs);
  } catch (err) {
    throw new LlmHttpError(`${label} (${model}) не ответил за ${timeoutMs}мс: ${err.message}`, 503);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new LlmHttpError(`${label} (${model}) вернул ошибку ${res.status}: ${errText.slice(0, 500)}`, res.status, parseRetryAfter(res));
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error(`${label} вернул пустой ответ.`);
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
  if (!data.response) throw new Error(`${label} вернул пустой ответ.`);
  return data.response;
}

function callOllamaCloud(prompt) {
  if (!OLLAMA_CLOUD_API_KEY) throw new Error("OLLAMA_CLOUD_API_KEY не задан.");
  return callOllamaApi({
    baseUrl: OLLAMA_CLOUD_URL,
    model: OLLAMA_CLOUD_MODEL,
    apiKey: OLLAMA_CLOUD_API_KEY,
    timeoutMs: OLLAMA_CLOUD_TIMEOUT_MS,
    prompt,
    label: "облачная Ollama",
  });
}

// Не подключена к цепочке (см. комментарий у OLLAMA_URL выше) — оставлена на случай отката.
function callOllamaLocal(prompt) {
  return callOllamaApi({
    baseUrl: OLLAMA_URL,
    model: OLLAMA_MODEL,
    apiKey: undefined,
    timeoutMs: OLLAMA_TIMEOUT_MS,
    prompt,
    label: "локальная Ollama",
  });
}

// Провайдеры цепочки: name — для сообщений об ошибках, configured — есть ли нужный ключ,
// call — сам запрос (бросает LlmHttpError/Error при неудаче).
const PROVIDERS = {
  groq: {
    name: "Groq",
    configured: () => Boolean(GROQ_API_KEY),
    call: (prompt) =>
      callOpenAiCompatible({
        url: "https://api.groq.com/openai/v1/chat/completions",
        apiKey: GROQ_API_KEY,
        model: GROQ_MODEL,
        prompt,
        label: "Groq",
        jsonMode: true,
        timeoutMs: CLOUD_TIMEOUT_MS,
      }),
  },
  cerebras: {
    name: "Cerebras",
    configured: () => Boolean(CEREBRAS_API_KEY),
    call: (prompt) =>
      callOpenAiCompatible({
        url: "https://api.cerebras.ai/v1/chat/completions",
        apiKey: CEREBRAS_API_KEY,
        model: CEREBRAS_MODEL,
        prompt,
        label: "Cerebras",
        jsonMode: false,
        timeoutMs: CLOUD_TIMEOUT_MS,
      }),
  },
  gemini: {
    name: "Gemini",
    configured: () => Boolean(GEMINI_API_KEY),
    call: (prompt) => callGeminiModel(prompt),
  },
  mistral: {
    name: "Mistral",
    configured: () => Boolean(MISTRAL_API_KEY),
    call: (prompt) =>
      callOpenAiCompatible({
        url: "https://api.mistral.ai/v1/chat/completions",
        apiKey: MISTRAL_API_KEY,
        model: MISTRAL_MODEL,
        prompt,
        label: "Mistral",
        jsonMode: true,
        timeoutMs: CLOUD_TIMEOUT_MS,
      }),
  },
  cohere: {
    name: "Cohere",
    configured: () => Boolean(COHERE_API_KEY),
    call: (prompt) =>
      callOpenAiCompatible({
        url: "https://api.cohere.ai/compatibility/v1/chat/completions",
        apiKey: COHERE_API_KEY,
        model: COHERE_MODEL,
        prompt,
        label: "Cohere",
        jsonMode: false,
        timeoutMs: CLOUD_TIMEOUT_MS,
      }),
  },
  openrouter: {
    name: "OpenRouter",
    configured: () => Boolean(OPENROUTER_API_KEY),
    call: (prompt) =>
      callOpenAiCompatible({
        url: "https://openrouter.ai/api/v1/chat/completions",
        apiKey: OPENROUTER_API_KEY,
        model: OPENROUTER_MODEL,
        prompt,
        label: "OpenRouter",
        jsonMode: false,
        timeoutMs: CLOUD_TIMEOUT_MS,
      }),
  },
  githubModels: {
    name: "GitHub Models",
    configured: () => Boolean(GITHUB_MODELS_TOKEN),
    call: (prompt) =>
      callOpenAiCompatible({
        url: "https://models.github.ai/inference/chat/completions",
        apiKey: GITHUB_MODELS_TOKEN,
        model: GITHUB_MODELS_MODEL,
        prompt,
        label: "GitHub Models",
        jsonMode: false,
        timeoutMs: CLOUD_TIMEOUT_MS,
        extraHeaders: { Accept: "application/vnd.github+json" },
      }),
  },
  ollamaCloud: {
    name: "облачная Ollama",
    configured: () => Boolean(OLLAMA_CLOUD_API_KEY),
    call: (prompt) => callOllamaCloud(prompt),
  },
};

// Уровни цепочки — см. requirements.md, раздел 5.6.
const TIERS = [
  { primary: ["groq", "cerebras"], backup: "gemini" },
  { primary: ["mistral"], backup: "cohere" },
  { primary: ["openrouter"], backup: "githubModels" },
];

// Отдельные уровни для промпта 5.5.2 (сопоставление тезисов с требованиями): без Groq в
// уровне A — на практике Groq заметно хуже Gemini/Cerebras следует строгому лексическому
// правилу совпадения (см. requirements.md 5.6), подбирая тезисы почти без разбора. Для
// промпта 5.5.1 (структурирование вакансии) риск от нестрогого сопоставления не актуален —
// там Groq остаётся в общей TIERS.
const TIERS_MATCHING = [
  { primary: ["cerebras"], backup: "gemini" },
  { primary: ["mistral"], backup: "cohere" },
  { primary: ["openrouter"], backup: "githubModels" },
];

const FINAL_FALLBACK = "ollamaCloud";

async function tryProvider(key, prompt, errors) {
  const provider = PROVIDERS[key];
  if (!provider.configured()) {
    errors.push(`${provider.name}: пропущен — не задан API-ключ`);
    throw new Error("not configured");
  }
  if (isExhausted(key)) {
    errors.push(`${provider.name}: пропущен — недавно вернул 429 (лимит исчерпан)`);
    throw new Error("exhausted");
  }
  try {
    const text = await provider.call(prompt);
    return JSON.parse(stripJsonFences(text));
  } catch (err) {
    if (err instanceof LlmHttpError && err.status === 429) markExhausted(key, err.retryAfterSeconds);
    errors.push(`${provider.name}: ${err.message}`);
    throw err;
  }
}

// Гонка провайдеров одного уровня: берём первый успешный ответ (Promise.any), а не ждём
// каждого по очереди. При одном провайдере в списке гонка вырождается в обычный вызов.
async function raceTier(keys, prompt, errors) {
  try {
    return await Promise.any(keys.map((key) => tryProvider(key, prompt, errors)));
  } catch {
    return null;
  }
}

async function callLLM(prompt, tiers = TIERS) {
  const errors = [];

  for (const tier of tiers) {
    let result = await raceTier(tier.primary, prompt, errors);
    if (result == null) result = await raceTier([tier.backup], prompt, errors);
    if (result != null) return result;
  }

  const result = await raceTier([FINAL_FALLBACK], prompt, errors);
  if (result != null) return result;

  throw new Error("Все LLM-провайдеры недоступны:\n" + errors.join("\n"));
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
артефакта или деятельность — общие слова вроде "проект", "работа", "опыт", "бизнес",
"аналитика", "разработка" не считаются. Аббревиатуры на разных языках для одного и того же
артефакта — совпадение (например "ФТ" и "FR" — функциональные требования). Пример
НЕсовпадения: "разработка архитектурного проекта" и "управление проектами разработки
маркетплейсов" — общее только слово "проект". Пример совпадения: "разработка прототипов" и
"прототипирование в Figma" — общий корень "прототип".

Отдельное правило для требований о стаже вида "опыт от N лет": тезис засчитывается, если в
нём указано численное значение общего стажа ≥ N, даже если название должности не совпадает
дословно (например тезис "10+ лет опыта" покрывает требование "от 5 лет").

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
  const result = await callLLM(buildGeneratePrompt(inputJson), TIERS_MATCHING);
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
