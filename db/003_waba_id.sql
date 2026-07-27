-- Phase 4: template sync needs the WABA id, and outbound needs a place
-- to record why a send was rejected before it ever reached Meta.

ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS send_rate_per_second INTEGER NOT NULL DEFAULT 20;

CREATE INDEX IF NOT EXISTS idx_messages_outbound_pending
  ON messages(tenant_id, status)
  WHERE direction = 'outbound' AND status IN ('queued', 'failed');