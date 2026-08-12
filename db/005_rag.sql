-- Phase 7: retrieval-augmented answers.
--
-- Requires the pgvector extension:
--   brew install pgvector       (or: apt install postgresql-17-pgvector)
-- then this migration enables it.

CREATE EXTENSION IF NOT EXISTS vector;

-- A source document: a pasted block of text or an uploaded file.
CREATE TABLE kb_documents (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  source_type  TEXT NOT NULL DEFAULT 'paste'
               CHECK (source_type IN ('paste', 'file')),
  filename     TEXT,
  content      TEXT NOT NULL,
  chunk_count  INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'indexed', 'error')),
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  indexed_at   TIMESTAMPTZ
);
CREATE INDEX idx_kb_documents_tenant ON kb_documents(tenant_id);

-- One passage of a document, with its embedding.
-- 768 dimensions matches nomic-embed-text. Changing the embedding model
-- means changing this number and re-indexing everything.
CREATE TABLE kb_chunks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id  UUID NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  chunk_index  INTEGER NOT NULL,
  content      TEXT NOT NULL,
  embedding    vector(768),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_kb_chunks_tenant ON kb_chunks(tenant_id);

-- Cosine distance index. ivfflat needs rows before it helps, so it is
-- built here but only pays off once there is real content.
CREATE INDEX idx_kb_chunks_embedding
  ON kb_chunks USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- What the bot retrieved and answered, so bad answers can be traced back
-- to the passages that caused them.
CREATE TABLE rag_answers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id     UUID REFERENCES conversations(id) ON DELETE CASCADE,
  question            TEXT NOT NULL,
  answer              TEXT,
  chunk_ids           UUID[] NOT NULL DEFAULT '{}',
  top_score           REAL,
  outcome             TEXT NOT NULL,
  latency_ms          INTEGER,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_rag_answers_tenant ON rag_answers(tenant_id, created_at DESC);

-- 'rag' joins the existing rule types. It runs after keyword rules, so
-- the cheap deterministic matches win first.
ALTER TABLE bot_rules DROP CONSTRAINT IF EXISTS bot_rules_match_type_check;
ALTER TABLE bot_rules ADD CONSTRAINT bot_rules_match_type_check
  CHECK (match_type IN ('keyword','exact','greeting','fallback','rag'));

-- Retrieval tuning, per tenant.
ALTER TABLE bot_settings
  ADD COLUMN IF NOT EXISTS rag_min_score REAL NOT NULL DEFAULT 0.35,
  ADD COLUMN IF NOT EXISTS rag_top_k INTEGER NOT NULL DEFAULT 4,
  ADD COLUMN IF NOT EXISTS rag_system_prompt TEXT;