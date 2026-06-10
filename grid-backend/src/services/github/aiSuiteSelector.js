import { logger } from "../../logger.js";

const OPENAI_DEFAULT_MODEL = "gpt-4o-mini";
const ANTHROPIC_DEFAULT_MODEL = "claude-3-5-haiku-20241022";
const AI_TIMEOUT_MS = 30_000;

export async function selectTestsForDiff({
  aiKey,
  changedFiles,
  availableSuites,
}) {
  if (!aiKey || !aiKey.api_key) {
    throw new Error("AI key required for dynamic suite selection");
  }
  if (!availableSuites || availableSuites.length === 0) {
    return { suiteIds: [], reasoning: "No suites discovered — falling back to no-op." };
  }

  const prompt = buildPrompt({ changedFiles, availableSuites });
  const provider = aiKey.provider;
  const model = aiKey.default_model || (provider === "openai" ? OPENAI_DEFAULT_MODEL : ANTHROPIC_DEFAULT_MODEL);

  try {
    const text = provider === "anthropic"
      ? await callAnthropic({ apiKey: aiKey.api_key, model, prompt })
      : await callOpenAi({ apiKey: aiKey.api_key, model, prompt });
    return parseSelection(text, availableSuites);
  } catch (err) {
    logger.error("AI suite selection failed:", err.message);
    return {
      suiteIds: availableSuites.map((s) => s.id),
      reasoning: `AI selection failed (${err.message}); ran all discovered suites instead.`,
    };
  }
}

function buildPrompt({ changedFiles, availableSuites }) {
  const fileLines = changedFiles
    .slice(0, 200)
    .map((f) => `- ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})`)
    .join("\n");
  const suiteLines = availableSuites
    .map((s) => `- id=${s.id} kind=${s.suite_kind} label="${s.suite_label}"`)
    .join("\n");
  return `You are choosing which test suites to run for a pull request.

Changed files in the development repo:
${fileLines}

Available test suites in the test repo:
${suiteLines}

Return JSON with this exact shape:
{ "suiteIds": ["<uuid>", ...], "reasoning": "<one or two sentences>" }

Pick only the suites whose labels suggest coverage of the changed files. If unsure, prefer including a suite rather than excluding it. Return at most 5 suite ids.`;
}

async function callOpenAi({ apiKey, model, prompt }) {
  const data = await fetchJsonWithTimeout("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Return strict JSON only." },
        { role: "user", content: prompt },
      ],
    }),
  });
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenAI response did not include content");
  return text;
}

async function callAnthropic({ apiKey, model, prompt }) {
  const data = await fetchJsonWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 600,
      temperature: 0.1,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const text = Array.isArray(data?.content)
    ? data.content.find((c) => c?.type === "text")?.text
    : null;
  if (!text) throw new Error("Anthropic response did not include text content");
  return text;
}

async function fetchJsonWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = payload?.error?.message || payload?.error?.type || JSON.stringify(payload || {});
      throw new Error(`AI provider error (${response.status}): ${detail}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function parseSelection(rawText, availableSuites) {
  const validIds = new Set(availableSuites.map((s) => s.id));
  let json = rawText.trim();
  const fenced = json.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) json = fenced[1].trim();
  const start = json.indexOf("{");
  const end = json.lastIndexOf("}");
  if (start >= 0 && end > start) json = json.slice(start, end + 1);
  let parsed;
  try { parsed = JSON.parse(json); } catch {
    return { suiteIds: availableSuites.map((s) => s.id), reasoning: "Could not parse AI response — running all suites." };
  }
  const suiteIds = Array.isArray(parsed.suiteIds)
    ? parsed.suiteIds.filter((id) => validIds.has(id)).slice(0, 5)
    : [];
  const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning.slice(0, 500) : "";
  if (suiteIds.length === 0) {
    return { suiteIds: availableSuites.map((s) => s.id), reasoning: `${reasoning} (No valid ids returned; ran all suites.)` };
  }
  return { suiteIds, reasoning };
}
