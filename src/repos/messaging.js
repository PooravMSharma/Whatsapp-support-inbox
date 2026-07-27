import { config } from '../config.js';

/**
 * Every function here takes an explicit tenantId. That is deliberate —
 * it makes it hard to write a query that leaks across tenants.
 */

export async function upsertContact(client, { tenantId, waId, profileName }) {
  const { rows } = await client.query(
    `INSERT INTO contacts (tenant_id, wa_id, profile_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, wa_id) DO UPDATE
       SET profile_name = COALESCE(EXCLUDED.profile_name, contacts.profile_name),
           updated_at = now()
     RETURNING *`,
    [tenantId, waId, profileName]
  );
  return rows[0];
}

export async function getOrCreateConversation(client, { tenantId, channelId, contactId }) {
  const { rows } = await client.query(
    `INSERT INTO conversations (tenant_id, channel_id, contact_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (channel_id, contact_id) DO UPDATE
       SET updated_at = now()
     RETURNING *`,
    [tenantId, channelId, contactId]
  );
  return rows[0];
}

/**
 * An inbound message reopens the 24h service window and un-resolves
 * the thread. This is the single place that rule lives.
 */
export async function applyInbound(client, { conversationId, preview, at }) {
  const { rows } = await client.query(
    `UPDATE conversations
        SET window_expires_at = $2::timestamptz + ($3 || ' hours')::interval,
            status = CASE WHEN status = 'resolved' THEN 'open' ELSE status END,
            unread_count = unread_count + 1,
            last_message_at = $2,
            last_message_preview = LEFT(COALESCE($4, ''), 160),
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [conversationId, at, String(config.windowHours), preview]
  );
  return rows[0];
}

export async function insertMessage(client, msg) {
  const { rows } = await client.query(
    `INSERT INTO messages
       (tenant_id, conversation_id, direction, provider_message_id,
        type, body, media, raw, status, sent_by_agent_id, sent_by_bot, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12, now()))
     ON CONFLICT (provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING
     RETURNING *`,
    [
      msg.tenantId,
      msg.conversationId,
      msg.direction,
      msg.providerMessageId ?? null,
      msg.type ?? 'text',
      msg.body ?? null,
      msg.media ? JSON.stringify(msg.media) : null,
      msg.raw ? JSON.stringify(msg.raw) : null,
      msg.status ?? 'received',
      msg.sentByAgentId ?? null,
      msg.sentByBot ?? false,
      msg.createdAt ?? null,
    ]
  );
  return rows[0] || null;
}

const STATUS_RANK = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

/**
 * Status webhooks arrive out of order. Never downgrade a status.
 */
export async function updateMessageStatus(client, { providerMessageId, status, error }) {
  const { rows } = await client.query(
    `UPDATE messages
        SET status = $2,
            error = COALESCE($3, error),
            updated_at = now()
      WHERE provider_message_id = $1
        AND $4 > CASE status
                   WHEN 'queued' THEN 0 WHEN 'sent' THEN 1
                   WHEN 'delivered' THEN 2 WHEN 'read' THEN 3
                   WHEN 'failed' THEN 4 ELSE -1 END
      RETURNING *`,
    [providerMessageId, status, error ? JSON.stringify(error) : null, STATUS_RANK[status] ?? -1]
  );
  return rows[0] || null;
}

export async function recordConversationUsage(client, params) {
  await client.query(
    `INSERT INTO usage_conversations
       (tenant_id, channel_id, conversation_id, category, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [params.tenantId, params.channelId, params.conversationId,
     params.category, params.expiresAt]
  );
}