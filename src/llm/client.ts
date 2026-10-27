import { config } from '../config.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

export class LlmUnavailableError extends Error {}

export function isLlmConfigured(): boolean {
  return Boolean(config().GROQ_API_KEY);
}

/**
 * Запрос к Groq (OpenAI-совместимый API) с ответом в JSON.
 * validate получает текст ответа и бросает исключение, если ответ не годится.
 */
export async function completeJson<T>(messages: ChatMessage[], validate: (raw: string) => T): Promise<T> {
  const cfg = config();
  if (!cfg.GROQ_API_KEY) throw new LlmUnavailableError('GROQ_API_KEY is not set');
  const isReasoning = /gpt-oss|qwen3/i.test(cfg.GROQ_MODEL);

  let response: Response;
  try {
    response = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: cfg.GROQ_MODEL,
        ...(isReasoning ? { reasoning_effort: 'low' } : {}),
        messages,
        temperature: 0,
        max_tokens: 600,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(cfg.LLM_TIMEOUT_MS),
    });
  } catch (error) {
    throw new LlmUnavailableError(`groq: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new LlmUnavailableError(`groq: HTTP ${response.status} ${text.slice(0, 200)}`);
  }
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new LlmUnavailableError('groq: empty response');
  return validate(content);
}

/** Достаёт первый JSON-объект из ответа (модели иногда оборачивают его в ```json). */
export function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('no JSON object in response');
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}
