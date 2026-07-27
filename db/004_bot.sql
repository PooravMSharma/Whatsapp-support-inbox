-- Phase 6: the automation layer.

-- Per-tenant automation switches. One row per tenant.
CREATE TABLE bot_settings (
  tenant_id        UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled          BOOLEAN NOT NULL DEFAULT false,
  -- Quiet period after a human replies, so the bot never talks over an agent.
  human_grace_minutes INTEGER NOT NULL DEFAULT 60,
  -- Stops runaway loops: at most N bot replies per conversation per hour.
  max_replies_per_hour INTEGER NOT NULL DEFAULT 6,
  business_hours   JSONB NOT NULL DEFAULT
    '{"timezone":"Asia/Kolkata","days":[1,2,3,4,5,6],"open":"09:00","close":"19:00"}'::jsonb,
  off_hours_reply  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rules are evaluated in priority order; the first match wins.
CREATE TABLE bot_rules (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  priority     INTEGER NOT NULL DEFAULT 100,
  is_active    BOOLEAN NOT NULL DEFAULT true,

  -- keyword  : any listed word appears in the message
  -- exact    : the whole message equals a listed phrase
  -- greeting : the contact's first ever message
  -- fallback : nothing else matched
  match_type   TEXT NOT NULL DEFAULT 'keyword'
               CHECK (match_type IN ('keyword','exact','greeting','fallback')),
  keywords     TEXT[] NOT NULL DEFAULT '{}',

  -- reply    : send the text
  -- escalate : hand to a human, optionally with a holding message
  action       TEXT NOT NULL DEFAULT 'reply'
               CHECK (action IN ('reply','escalate')),
  reply_text   TEXT,

  -- Escalation extras
  assign_to_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  pause_minutes      INTEGER NOT NULL DEFAULT 120,

  hit_count    INTEGER NOT NULL DEFAULT 0,
  last_hit_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_bot_rules_eval
  ON bot_rules(tenant_id, is_active, priority);

-- Which rule answered which message. Needed to tune rules later, and to
-- count recent bot replies for the loop guard.
CREATE TABLE bot_replies (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id  UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  rule_id          UUID REFERENCES bot_rules(id) ON DELETE SET NULL,
  inbound_message_id  UUID REFERENCES messages(id) ON DELETE SET NULL,
  outbound_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  outcome          TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_bot_replies_recent
  ON bot_replies(conversation_id, created_at DESC);

-- When a human last spoke, so the bot can stay quiet afterwards.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS last_human_reply_at TIMESTAMPTZ;