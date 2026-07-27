import { many, one, query } from '../lib/db.js';

/**
 * Conversation list for the inbox.
 * filter: 'all' | 'mine' | 'unassigned' | 'resolved'
 */
export async function listConversations({ tenantId, agentId, filter = 'all', limit = 50, cursor }) {
  const params = [tenantId];
  const where = ['c.tenant_id = $1'];

  if (filter === 'mine') {
    params.push(agentId);
    where.push(`c.assigned_agent_id = $${params.length}`, `c.status <> 'resolved'`);
  } else if (filter === 'unassigned') {
    where.push('c.assigned_agent_id IS NULL', `c.status <> 'resolved'`);
  } else if (filter === 'resolved') {
    where.push(`c.status = 'resolved'`);
  } else {
    where.push(`c.status <> 'resolved'`);
  }

  if (cursor) {
    params.push(cursor);
    where.push(`c.last_message_at < $${params.length}`);
  }

  params.push(limit);

  return many(
    `SELECT c.id, c.status, c.unread_count, c.last_message_at,
            c.last_message_preview, c.window_expires_at, c.bot_paused_until,
            c.assigned_agent_id,
            ct.wa_id, ct.profile_name,
            ag.name AS assigned_agent_name,
            (c.window_expires_at > now()) AS window_open
       FROM conversations c
       JOIN contacts ct ON ct.id = c.contact_id
       LEFT JOIN agents ag ON ag.id = c.assigned_agent_id
      WHERE ${where.join(' AND ')}
      ORDER BY c.last_message_at DESC NULLS LAST
      LIMIT $${params.length}`,
    params
  );
}

export async function getConversation({ tenantId, conversationId }) {
  return one(
    `SELECT c.*, ct.wa_id, ct.profile_name, ct.attributes,
            ag.name AS assigned_agent_name,
            (c.window_expires_at > now()) AS window_open
       FROM conversations c
       JOIN contacts ct ON ct.id = c.contact_id
       LEFT JOIN agents ag ON ag.id = c.assigned_agent_id
      WHERE c.tenant_id = $1 AND c.id = $2`,
    [tenantId, conversationId]
  );
}

/** Thread messages, newest first, paginated backwards through history. */
export async function listMessages({ tenantId, conversationId, limit = 50, before }) {
  const params = [tenantId, conversationId];
  let cursorClause = '';
  if (before) {
    params.push(before);
    cursorClause = `AND m.created_at < $${params.length}`;
  }
  params.push(limit);

  return many(
    `SELECT m.id, m.direction, m.type, m.body, m.media, m.status,
            m.error, m.sent_by_bot, m.created_at,
            ag.name AS agent_name
       FROM messages m
       LEFT JOIN agents ag ON ag.id = m.sent_by_agent_id
      WHERE m.tenant_id = $1 AND m.conversation_id = $2 ${cursorClause}
      ORDER BY m.created_at DESC
      LIMIT $${params.length}`,
    params
  );
}

export async function assignConversation({ tenantId, conversationId, agentId }) {
  return one(
    `UPDATE conversations
        SET assigned_agent_id = $3, updated_at = now()
      WHERE tenant_id = $1 AND id = $2
      RETURNING *`,
    [tenantId, conversationId, agentId]
  );
}

export async function setStatus({ tenantId, conversationId, status }) {
  return one(
    `UPDATE conversations
        SET status = $3, updated_at = now()
      WHERE tenant_id = $1 AND id = $2
      RETURNING *`,
    [tenantId, conversationId, status]
  );
}

export async function markRead({ tenantId, conversationId }) {
  return one(
    `UPDATE conversations
        SET unread_count = 0, last_read_at = now(), updated_at = now()
      WHERE tenant_id = $1 AND id = $2
      RETURNING *`,
    [tenantId, conversationId]
  );
}

/**
 * Human takeover. Pausing the bot is what stops automation from talking
 * over an agent mid-conversation.
 */
export async function setBotPause({ tenantId, conversationId, minutes }) {
  return one(
    `UPDATE conversations
        SET bot_paused_until = CASE
              WHEN $3::int IS NULL THEN NULL
              ELSE now() + ($3 || ' minutes')::interval
            END,
            updated_at = now()
      WHERE tenant_id = $1 AND id = $2
      RETURNING *`,
    [tenantId, conversationId, minutes]
  );
}

export async function inboxCounts({ tenantId, agentId }) {
  return one(
    `SELECT
       count(*) FILTER (WHERE status <> 'resolved')                       AS open,
       count(*) FILTER (WHERE status <> 'resolved'
                          AND assigned_agent_id IS NULL)                  AS unassigned,
       count(*) FILTER (WHERE status <> 'resolved'
                          AND assigned_agent_id = $2)                     AS mine,
       coalesce(sum(unread_count) FILTER (WHERE status <> 'resolved'), 0) AS unread
     FROM conversations
    WHERE tenant_id = $1`,
    [tenantId, agentId]
  );
}

export async function listAgents({ tenantId }) {
  return many(
    `SELECT id, name, email, role FROM agents
      WHERE tenant_id = $1 AND is_active = true ORDER BY name`,
    [tenantId]
  );
}