import { chat, OllamaError } from './ollama.js';
import { retrieve, logAnswer } from '../repos/kb.js';

/**
 * Retrieval-augmented answering.
 *
 * The hard rule: the model may only use the passages it is given. A bot
 * that invents a refund policy or a price is worse than one that says
 * nothing, because a customer will act on it and the business is bound by
 * what it appears to have promised.
 *
 * Three guards enforce that:
 *   1. If the best passage scores below the threshold, do not call the
 *      model at all — escalate.
 *   2. The system prompt forbids outside knowledge and gives an explicit
 *      escape hatch.
 *   3. If the model uses that escape hatch, escalate rather than send it.
 */

const NO_ANSWER = 'INSUFFICIENT_CONTEXT';

function buildSystemPrompt(custom) {
  const base = `You answer customer questions for a business on WhatsApp.

Rules you must follow:
- Use ONLY the numbered context passages provided. They are the entire
  source of truth.
- If the passages do not contain the answer, reply with exactly:
  ${NO_ANSWER}
- Never guess, never generalise from common knowledge, and never invent
  prices, timings, policies, names or availability.
- Answer in 1-3 short sentences. This is a chat message, not an article.
- Write plainly and warmly, as a person at the business would.
- Do not mention the passages, the context, or that you are an AI.
- Match the language the customer wrote in.`;

  return custom ? `${base}\n\nAbout this business:\n${custom}` : base;
}

function buildUserPrompt(question, chunks) {
  const context = chunks
    .map((c, i) => `[${i + 1}] ${c.content}`)
    .join('\n\n');

  return `Context passages:\n\n${context}\n\nCustomer question: ${question}`;
}

/**
 * Returns one of:
 *   { outcome: 'answered',            text }
 *   { outcome: 'escalated_low_score', topScore }
 *   { outcome: 'escalated_no_answer' }
 *   { outcome: 'error',               error }
 *
 * Never throws. A retrieval failure must not take down message ingestion.
 */
export async function answerFromKnowledge({
  tenantId,
  conversationId = null,
  question,
  minScore = 0.35,
  topK = 4,
  systemPromptExtra = null,
}) {
  const started = Date.now();
  let chunks = [];

  try {
    chunks = await retrieve(tenantId, question, { topK });

    const topScore = chunks[0]?.score ?? 0;

    // Guard 1: nothing close enough. Do not spend a model call, and do
    // not let a weak match become a confident-sounding wrong answer.
    if (!chunks.length || topScore < minScore) {
      await logAnswer({
        tenantId, conversationId, question,
        chunkIds: chunks.map((c) => c.id),
        topScore,
        outcome: 'escalated_low_score',
        latencyMs: Date.now() - started,
      });
      return { outcome: 'escalated_low_score', topScore, chunks };
    }

    const text = await chat({
      system: buildSystemPrompt(systemPromptExtra),
      user: buildUserPrompt(question, chunks),
    });

    // Guard 3: the model said it could not answer from the passages.
    if (text.includes(NO_ANSWER)) {
      await logAnswer({
        tenantId, conversationId, question,
        chunkIds: chunks.map((c) => c.id),
        topScore,
        outcome: 'escalated_no_answer',
        latencyMs: Date.now() - started,
      });
      return { outcome: 'escalated_no_answer', topScore, chunks };
    }

    await logAnswer({
      tenantId, conversationId, question, answer: text,
      chunkIds: chunks.map((c) => c.id),
      topScore,
      outcome: 'answered',
      latencyMs: Date.now() - started,
    });

    return { outcome: 'answered', text, topScore, chunks };
  } catch (err) {
    const outcome = err instanceof OllamaError ? 'error:ollama' : 'error';

    await logAnswer({
      tenantId, conversationId, question,
      chunkIds: chunks.map((c) => c.id),
      outcome,
      latencyMs: Date.now() - started,
    }).catch(() => {});

    return { outcome: 'error', error: err.message };
  }
}