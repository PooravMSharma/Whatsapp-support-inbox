import { many, one, query } from '../lib/db.js';

export async function getSettings(tenantId) {
  const row = await one(`SELECT * FROM bot_settings WHERE tenant_id = $1`, [tenantId]);
  if (row) return row;

  // First read creates the row, disabled. Automation is opt-in.
  return one(
    `INSERT INTO bot_settings (tenant_id) VALUES ($1)
     ON CONFLICT (tenant_id) DO UPDATE SET updated_at = now()
     RETURNING *`,
    [tenantId]
  );
}

export async function updateSettings(tenantId, patch) {
  const current = await getSettings(tenantId);
  return one(
    `UPDATE bot_settings
        SET enabled = $2,
            human_grace_minutes = $3,
            max_replies_per_hour = $4,
            business_hours = $5,
            off_hours_reply = $6,
            updated_at = now()
      WHERE tenant_id = $1
      RETURNING *`,
    [
      tenantId,
      patch.enabled ?? current.enabled,
      patch.humanGraceMinutes ?? current.human_grace_minutes,
      patch.maxRepliesPerHour ?? current.max_replies_per_hour,
      JSON.stringify(patch.businessHours ?? current.business_hours),
      'offHoursReply' in patch ? patch.offHoursReply : current.off_hours_reply,
    ]
  );
}

export async function listRules(tenantId, { activeOnly = false } = {}) {
  return many(
    `SELECT * FROM bot_rules
      WHERE tenant_id = $1 ${activeOnly ? 'AND is_active = true' : ''}
      ORDER BY priority, created_at`,
    [tenantId]
  );
}

export async function createRule(tenantId, r) {
  return one(
    `INSERT INTO bot_rules
       (tenant_id, name, priority, match_type, keywords, action,
        reply_text, assign_to_agent_id, pause_minutes, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      tenantId,
      r.name,
      r.priority ?? 100,
      r.matchType ?? 'keyword',
      r.keywords ?? [],
      r.action ?? 'reply',
      r.replyText ?? null,
      r.assignToAgentId ?? null,
      r.pauseMinutes ?? 120,
      r.isActive ?? true,
    ]
  );
}

export async function updateRule(tenantId, id, r) {
  const current = await one(
    `SELECT * FROM bot_rules WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id]
  );
  if (!current) return null;

  return one(
    `UPDATE bot_rules
        SET name = $3, priority = $4, match_type = $5, keywords = $6,
            action = $7, reply_text = $8, assign_to_agent_id = $9,
            pause_minutes = $10, is_active = $11, updated_at = now()
      WHERE tenant_id = $1 AND id = $2
      RETURNING *`,
    [
      tenantId, id,
      r.name ?? current.name,
      r.priority ?? current.priority,
      r.matchType ?? current.match_type,
      r.keywords ?? current.keywords,
      r.action ?? current.action,
      'replyText' in r ? r.replyText : current.reply_text,
      'assignToAgentId' in r ? r.assignToAgentId : current.assign_to_agent_id,
      r.pauseMinutes ?? current.pause_minutes,
      r.isActive ?? current.is_active,
    ]
  );
}

export async function deleteRule(tenantId, id) {
  const { rowCount } = await query(
    `DELETE FROM bot_rules WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id]
  );
  return rowCount > 0;
}

export async function recordHit(ruleId) {
  await query(
    `UPDATE bot_rules SET hit_count = hit_count + 1, last_hit_at = now()
      WHERE id = $1`,
    [ruleId]
  );
}

export async function logReply(entry) {
  await query(
    `INSERT INTO bot_replies
       (tenant_id, conversation_id, rule_id, inbound_message_id,
        outbound_message_id, outcome)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      entry.tenantId,
      entry.conversationId,
      entry.ruleId ?? null,
      entry.inboundMessageId ?? null,
      entry.outboundMessageId ?? null,
      entry.outcome,
    ]
  );
}

export async function repliesInLastHour(conversationId) {
  const row = await one(
    `SELECT count(*)::int AS n FROM bot_replies
      WHERE conversation_id = $1
        AND outbound_message_id IS NOT NULL
        AND created_at > now() - interval '1 hour'`,
    [conversationId]
  );
  return row?.n ?? 0;
}

/** Has this contact ever written before this message? */
export async function isFirstMessage(conversationId, messageId) {
  const row = await one(
    `SELECT count(*)::int AS n FROM messages
      WHERE conversation_id = $1
        AND direction = 'inbound'
        AND id <> $2`,
    [conversationId, messageId]
  );
  return (row?.n ?? 0) === 0;
}

export async function botStats(tenantId) {
  return one(
    `SELECT
       count(*) FILTER (WHERE outcome = 'replied')   AS replied,
       count(*) FILTER (WHERE outcome = 'escalated') AS escalated,
       count(*) FILTER (WHERE outcome LIKE 'skipped%') AS skipped
     FROM bot_replies
    WHERE tenant_id = $1 AND created_at > now() - interval '7 days'`,
    [tenantId]
  );
}