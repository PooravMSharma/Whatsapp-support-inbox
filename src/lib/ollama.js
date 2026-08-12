import { request } from 'undici';

/**
 * Ollama runs locally, so there is no API key and no per-token cost —
 * but it is a process on a machine, which means it can simply be down.
 * Every call here fails loudly rather than silently returning nothing,
 * so the bot escalates to a human instead of inventing an answer.
 */

const BASE = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
export const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
export const CHAT_MODEL = process.env.OLLAMA_CHAT_MODEL || 'llama3.2';

/** Dimension of EMBED_MODEL's output. Must match vector(n) in the schema. */
export const EMBED_DIMS = Number(process.env.OLLAMA_EMBED_DIMS || 768);

export class OllamaError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'OllamaError';
    this.status = status;
  }
}

async function post(path, body, timeoutMs = 60_000) {
  let res;
  try {
    res = await request(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
  } catch (err) {
    throw new OllamaError(`Cannot reach Ollama at ${BASE}: ${err.message}`);
  }

  const json = await res.body.json().catch(() => ({}));
  if (res.statusCode >= 400) {
    throw new OllamaError(json?.error || 'Ollama request failed', res.statusCode);
  }
  return json;
}

/** Embed one string. Returns a plain array of floats. */
export async function embed(text) {
  const json = await post('/api/embeddings', {
    model: EMBED_MODEL,
    prompt: text,
  });

  const vec = json.embedding;
  if (!Array.isArray(vec) || vec.length === 0) {
    throw new OllamaError('Ollama returned an empty embedding');
  }
  if (vec.length !== EMBED_DIMS) {
    throw new OllamaError(
      `Embedding is ${vec.length} dimensions but the schema expects ${EMBED_DIMS}. ` +
      `Either change OLLAMA_EMBED_DIMS and the vector(n) column, or use a different model.`
    );
  }
  return vec;
}

/** Embed many strings, sequentially — Ollama handles one at a time locally. */
export async function embedAll(texts, onProgress) {
  const out = [];
  for (let i = 0; i < texts.length; i++) {
    out.push(await embed(texts[i]));
    onProgress?.(i + 1, texts.length);
  }
  return out;
}

/** Single-turn completion. Low temperature: this is retrieval, not creativity. */
export async function chat({ system, user, temperature = 0.2, maxTokens = 300 }) {
  const json = await post('/api/chat', {
    model: CHAT_MODEL,
    stream: false,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    options: { temperature, num_predict: maxTokens },
  });

  const text = json?.message?.content?.trim();
  if (!text) throw new OllamaError('Ollama returned an empty completion');
  return text;
}

/** Is Ollama up, and are the models we need actually pulled? */
export async function health() {
  try {
    const res = await request(`${BASE}/api/tags`, { headersTimeout: 5000 });
    const json = await res.body.json();
    const names = (json.models ?? []).map((m) => m.name);
    const has = (want) => names.some((n) => n === want || n.startsWith(want + ':'));

    return {
      up: true,
      models: names,
      embedModel: EMBED_MODEL,
      chatModel: CHAT_MODEL,
      embedReady: has(EMBED_MODEL),
      chatReady: has(CHAT_MODEL),
    };
  } catch (err) {
    return { up: false, error: err.message };
  }
}

/** pgvector wants '[1,2,3]', not a JS array. */
export function toVectorLiteral(vec) {
  return `[${vec.join(',')}]`;
}