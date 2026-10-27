import { config } from '../config.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface Provider {
  name: string;
  baseUrl: string;
  apiKey: string;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

export class LlmUnavailableError extends Error {
  constructor(public readonly attempts: string[]) {
    super(`All LLM providers failed: ${attempts.join(' | ')}`);
  }
}

function providers(): Provider[] {
  const cfg = config();
  const result: Provider[] = [];
  for (const name of cfg.LLM_PROVIDERS.split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (name === 'groq' && cfg.GROQ_API_KEY) {
      const isReasoning = /gpt-oss|qwen3/i.test(cfg.GROQ_MODEL);
      result.push({
        name: `groq:${cfg.GROQ_MODEL}`,
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKey: cfg.GROQ_API_KEY,
        body: { model: cfg.GROQ_MODEL, ...(isReasoning ? { reasoning_effort: 'low' } : {}) },
      });
    }
    if (name === 'openrouter' && cfg.OPENROUTER_API_KEY) {
      const models = cfg.OPENROUTER_MODELS.split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      result.push({
        name: `openrouter:${models.join('|')}`,
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: cfg.OPENROUTER_API_KEY,
        // Несколько моделей: OpenRouter сам переключится на следующую при 429/ошибке
        body: models.length > 1 ? { models } : { model: models[0] },
        headers: { 'X-Title': 'english-lessons-bot' },
      });
    }
    if (name === 'custom' && cfg.LLM_BASE_URL && cfg.LLM_MODEL) {
      result.push({
        name: `custom:${cfg.LLM_MODEL}`,
        baseUrl: cfg.LLM_BASE_URL.replace(/\/$/, ''),
        apiKey: cfg.LLM_API_KEY ?? '',
        body: { model: cfg.LLM_MODEL },
      });
    }
  }
  return result;
}

export function isLlmConfigured(): boolean {
  return providers().length > 0;
}

/**
 * Запрос к первому доступному OpenAI-совместимому провайдеру.
 * validate получает текст ответа и бросает исключение, если ответ не годится —
 * тогда пробуем следующего провайдера.
 */
export async function completeJson<T>(messages: ChatMessage[], validate: (raw: string) => T): Promise<T> {
  const list = providers();
  if (list.length === 0) throw new LlmUnavailableError(['no providers configured']);
  const attempts: string[] = [];

  for (const provider of list) {
    try {
      const response = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${provider.apiKey}`,
          ...provider.headers,
        },
        body: JSON.stringify({
          ...provider.body,
          messages,
          temperature: 0,
          max_tokens: 600,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(config().LLM_TIMEOUT_MS),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        attempts.push(`${provider.name}: HTTP ${response.status} ${text.slice(0, 200)}`);
        continue;
      }
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string | null } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        attempts.push(`${provider.name}: empty response`);
        continue;
      }
      return validate(content);
    } catch (error) {
      attempts.push(`${provider.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new LlmUnavailableError(attempts);
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
