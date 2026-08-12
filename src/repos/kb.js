import { many, one, query, tx } from '../lib/db.js';
import { embed, embedAll, toVectorLiteral } from '../lib/ollama.js';

/**
 * Chunking strategy: split on blank lines first, because business
 * documents are already written in topic-sized paragraphs. Only fall back
 * to sentence splitting when a paragraph is too long to embed usefully.
 *
 * A chunk that spans two unrelated topics retrieves badly for both.
 */
const MAX_CHARS = 900;
const MIN_CHARS = 40;

export function chunkText(text) {
  const paragraphs = text
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks = [];

  for (const para of paragraphs) {
    if (para.length <= MAX_CHARS) {
      chunks.push(para);
      continue;
    }

    // Too long: split on sentence ends, then repack up to MAX_CHARS.
    const sentences = para.match(/[^.!?\n]+[.!?]*\s*/g) ?? [para];
    let buf = '';
    for (const s of sentences) {
      if ((buf + s).length > MAX_CHARS && buf) {
        chunks.push(buf.trim());
        buf = '';
      }
      buf += s;
    }
    if (buf.trim()) chunks.push(buf.trim());
  }

  // Drop fragments too short to carry meaning, but keep them if they are
  // all we have — a one-line document is still a document.
  const useful = chunks.filter((c) => c.length >= MIN_CHARS);
  return useful.length ? useful : chunks;
}

export async function listDocuments(tenantId) {
  return many(
    `SELECT id, title, source_type, filename, chunk_count, status, error,
            created_at, indexed_at, length(content) AS char_count
       FROM kb_documents
      WHERE tenant_id = $1
      ORDER BY created_at DESC`,
    [tenantId]
  );
}

export async function getDocument(tenantId, id) {
  return one(
    `SELECT * FROM kb_documents WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id]
  );
}

export async function createDocument(tenantId, { title, content, sourceType, filename }) {
  return one(
    `INSERT INTO kb_documents (tenant_id, title, content, source_type, filename)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [tenantId, title, content, sourceType ?? 'paste', filename ?? null]
  );
}

export async function deleteDocument(tenantId, id) {
  const { rowCount } = await query(
    `DELETE FROM kb_documents WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id]
  );
  return rowCount > 0;
}

/**
 * Embed every chunk and store it. Re-indexing replaces the old chunks
 * wholesale rather than diffing — documents are small and correctness
 * matters more than the wasted work.
 */
export async function indexDocument(tenantId, documentId, onProgress) {
  const doc = await getDocument(tenantId, documentId);
  if (!doc) throw new Error('Document not found');

  const chunks = chunkText(doc.content);
  if (!chunks.length) throw new Error('Document produced no chunks');

  try {
    const vectors = await embedAll(chunks, onProgress);

    await tx(async (client) => {
      await client.query(`DELETE FROM kb_chunks WHERE document_id = $1`, [documentId]);

      for (let i = 0; i < chunks.length; i++) {
        await client.query(
          `INSERT INTO kb_chunks (tenant_id, document_id, chunk_index, content, embedding)
           VALUES ($1, $2, $3, $4, $5::vector)`,
          [tenantId, documentId, i, chunks[i], toVectorLiteral(vectors[i])]
        );
      }

      await client.query(
        `UPDATE kb_documents
            SET chunk_count = $2, status = 'indexed', error = NULL, indexed_at = now()
          WHERE id = $1`,
        [documentId, chunks.length]
      );
    });

    return { chunks: chunks.length };
  } catch (err) {
    await query(
      `UPDATE kb_documents SET status = 'error', error = $2 WHERE id = $1`,
      [documentId, err.message]
    );
    throw err;
  }
}

/**
 * Nearest chunks by cosine similarity.
 *
 * pgvector's <=> is cosine DISTANCE (0 = identical), so similarity is
 * 1 - distance. Scores are returned so the caller can decide whether the
 * match is good enough to answer from.
 */
export async function retrieve(tenantId, question, { topK = 4 } = {}) {
  const vec = await embed(question);

  return many(
    `SELECT c.id, c.content, c.document_id, d.title,
            1 - (c.embedding <=> $2::vector) AS score
       FROM kb_chunks c
       JOIN kb_documents d ON d.id = c.document_id
      WHERE c.tenant_id = $1
        AND c.embedding IS NOT NULL
      ORDER BY c.embedding <=> $2::vector
      LIMIT $3`,
    [tenantId, toVectorLiteral(vec), topK]
  );
}

export async function logAnswer(entry) {
  await query(
    `INSERT INTO rag_answers
       (tenant_id, conversation_id, question, answer, chunk_ids,
        top_score, outcome, latency_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      entry.tenantId,
      entry.conversationId ?? null,
      entry.question,
      entry.answer ?? null,
      entry.chunkIds ?? [],
      entry.topScore ?? null,
      entry.outcome,
      entry.latencyMs ?? null,
    ]
  );
}

export async function ragStats(tenantId) {
  return one(
    `SELECT
       count(*)                                            AS total,
       count(*) FILTER (WHERE outcome = 'answered')        AS answered,
       count(*) FILTER (WHERE outcome = 'escalated_low_score') AS low_score,
       count(*) FILTER (WHERE outcome LIKE 'error%')       AS errors,
       round(avg(latency_ms))                              AS avg_latency_ms,
       round(avg(top_score)::numeric, 3)                   AS avg_top_score
     FROM rag_answers
    WHERE tenant_id = $1 AND created_at > now() - interval '7 days'`,
    [tenantId]
  );
}