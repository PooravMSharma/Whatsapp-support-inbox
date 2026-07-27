-- WhatsApp Automation Platform — initial schema
-- Multi-tenant, row-level isolation via tenant_id on every table.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------
-- Tenants: one row per client business the agency runs.
-- ---------------------------------------------------------------
CREATE TABLE tenants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'suspended')),
  timezone      TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------
-- Channels: a WhatsApp number belonging to a tenant.
-- phone_number_id is how we route inbound webhooks to a tenant.
-- ---------------------------------------------------------------
CREATE TABLE channels (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider           TEXT NOT NULL DEFAULT 'cloud_api'
                     CHECK (provider IN ('cloud_api', 'baileys')),
  phone_number_id    TEXT NOT NULL UNIQUE,   -- Meta's ID; the webhook routing key
  waba_id            TEXT,                   -- WhatsApp Business Account ID
  display_number     TEXT NOT NULL,          -- E.164, for humans
  access_token_enc   TEXT NOT NULL,          -- encrypted at rest
  status             TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'disabled', 'error')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_channels_tenant ON channels(tenant_id);

-- ---------------------------------------------------------------
-- Agents: humans who work the inbox.
-- ---------------------------------------------------------------
CREATE TABLE agents (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email          TEXT NOT NULL,
  name           TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'agent'
                 CHECK (role IN ('owner', 'admin', 'agent')),
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

-- ---------------------------------------------------------------
-- Contacts: end customers messaging a tenant.
-- ---------------------------------------------------------------
CREATE TABLE contacts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wa_id         TEXT NOT NULL,          -- E.164 without '+', as Meta sends it
  profile_name  TEXT,
  attributes    JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_blocked    BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, wa_id)
);
CREATE INDEX idx_contacts_tenant ON contacts(tenant_id);

-- ---------------------------------------------------------------
-- Conversations: one open thread per contact per channel.
-- window_expires_at drives the entire send-eligibility rule.
-- bot_paused_until is how human takeover silences automation.
-- ---------------------------------------------------------------
CREATE TABLE conversations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id          UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  contact_id          UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'pending', 'resolved')),
  assigned_agent_id   UUID REFERENCES agents(id) ON DELETE SET NULL,
  window_expires_at   TIMESTAMPTZ,     -- last inbound + 24h
  bot_paused_until    TIMESTAMPTZ,
  unread_count        INTEGER NOT NULL DEFAULT 0,
  last_message_at     TIMESTAMPTZ,
  last_message_preview TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel_id, contact_id)
);
CREATE INDEX idx_conversations_inbox
  ON conversations(tenant_id, status, last_message_at DESC);
CREATE INDEX idx_conversations_assigned
  ON conversations(tenant_id, assigned_agent_id, status);

-- ---------------------------------------------------------------
-- Messages. provider_message_id gives us idempotency against
-- Meta's duplicate webhook deliveries.
-- ---------------------------------------------------------------
CREATE TABLE messages (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id      UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction            TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  provider_message_id  TEXT,
  type                 TEXT NOT NULL DEFAULT 'text'
                       CHECK (type IN ('text','image','video','audio','document',
                                       'sticker','location','contacts','interactive',
                                       'button','template','system','unsupported')),
  body                 TEXT,
  media                JSONB,        -- { id, mime_type, sha256, filename, caption }
  raw                  JSONB,        -- original provider payload, for debugging
  status               TEXT NOT NULL DEFAULT 'received'
                       CHECK (status IN ('queued','sent','delivered','read',
                                         'failed','received')),
  error                JSONB,
  sent_by_agent_id     UUID REFERENCES agents(id) ON DELETE SET NULL,
  sent_by_bot          BOOLEAN NOT NULL DEFAULT false,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_messages_provider_id
  ON messages(provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX idx_messages_thread
  ON messages(conversation_id, created_at DESC);

-- ---------------------------------------------------------------
-- Templates: synced from Meta. Approval status matters before send.
-- ---------------------------------------------------------------
CREATE TABLE templates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id    UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  language      TEXT NOT NULL,
  category      TEXT,
  status        TEXT NOT NULL DEFAULT 'PENDING',
  components    JSONB NOT NULL DEFAULT '[]'::jsonb,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel_id, name, language)
);

-- ---------------------------------------------------------------
-- Webhook event log: dedupe + replay + audit.
-- ---------------------------------------------------------------
CREATE TABLE webhook_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key     TEXT NOT NULL UNIQUE,
  phone_number_id TEXT,
  tenant_id      UUID REFERENCES tenants(id) ON DELETE SET NULL,
  payload        JSONB NOT NULL,
  processed_at   TIMESTAMPTZ,
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_webhook_events_unprocessed
  ON webhook_events(created_at) WHERE processed_at IS NULL;

-- ---------------------------------------------------------------
-- Usage metering: per-tenant conversation billing from day one.
-- ---------------------------------------------------------------
CREATE TABLE usage_conversations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id      UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  category        TEXT,      -- marketing | utility | authentication | service
  opened_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ
);
CREATE INDEX idx_usage_tenant_month ON usage_conversations(tenant_id, opened_at);