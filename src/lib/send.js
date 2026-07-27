import { tx, one } from '../lib/db.js';
import { insertMessage } from '../repos/messaging.js';
import { findTemplate, buildTemplateComponents } from '../repos/templates.js';
import { outboundQueue } from '../lib/queue.js';
import { publish } from '../lib/events.js';

/**
 * THE guarded send path. Nothing else in the app may call the channel
 * adapter directly — agents, bots and future campaigns all come through
 * here, so the 24-hour window rule is enforced in exactly one place.
 */

export class SendError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'SendError';
    this.code = code;
    this.extra = extra;
  }
}

async function loadContext(tenantId, conversationId) {
  const row = await one(
    `SELECT c.id AS conversation_id,
            c.tenant_id,
            c.window_expires_at,
            (c.window_expires_at > now()) AS window_open,
            ct.wa_id,
            ct.is_blocked,
            ch.id AS channel_id,
            ch.status AS channel_status
       FROM conversations c
       JOIN contacts ct ON ct.id = c.contact_id
       JOIN channels ch ON ch.id = c.channel_id
      WHERE c.tenant_id = $1 AND c.id = $2`,
    [tenantId, conversationId]
  );

  if (!row) throw new SendError('not_found', 'Conversation not found');
  if (row.is_blocked) throw new SendError('contact_blocked', 'Contact is blocked');
  if (row.channel_status !== 'active') {
    throw new SendError('channel_inactive', 'Channel is not active');
  }
  return row;
}

/**
 * Free-form text. Only legal inside the 24-hour service window; outside
 * it, WhatsApp requires an approved template.
 */
export async function sendText({ tenantId, conversationId, text, agentId = null, byBot = false }) {
  if (!text || !text.trim()) {
    throw new SendError('empty_body', 'Message body is required');
  }
  if (text.length > 4096) {
    throw new SendError('too_long', 'WhatsApp text messages cap at 4096 characters');
  }

  const ctx = await loadContext(tenantId, conversationId);

  if (!ctx.window_open) {
    throw new SendError(
      'window_closed',
      'The 24-hour service window has closed. Send an approved template instead.',
      { windowExpiredAt: ctx.window_expires_at }
    );
  }

  return enqueue({
    ctx,
    agentId,
    byBot,
    type: 'text',
    body: text,
    job: { kind: 'text', text },
  });
}

/**
 * Templates are the only thing sendable outside the window, and only if
 * Meta has approved them.
 */
export async function sendTemplate({
  tenantId,
  conversationId,
  name,
  language,
  variables = {},
  agentId = null,
  byBot = false,
}) {
  const ctx = await loadContext(tenantId, conversationId);

  const template = await findTemplate({ tenantId, name, language });
  if (!template) {
    throw new SendError('template_not_found', `No template ${name}/${language}`);
  }
  if (template.status !== 'APPROVED') {
    throw new SendError(
      'template_not_approved',
      `Template ${name} is ${template.status}, not APPROVED`
    );
  }

  const components = buildTemplateComponents(variables);

  return enqueue({
    ctx,
    agentId,
    byBot,
    type: 'template',
    body: `[template: ${name}]`,
    job: { kind: 'template', name, language, components },
  });
}

export async function sendMedia({
  tenantId,
  conversationId,
  type,
  link,
  caption,
  filename,
  agentId = null,
  byBot = false,
}) {
  const allowed = ['image', 'video', 'audio', 'document'];
  if (!allowed.includes(type)) {
    throw new SendError('bad_media_type', `type must be one of ${allowed.join(', ')}`);
  }

  const ctx = await loadContext(tenantId, conversationId);
  if (!ctx.window_open) {
    throw new SendError('window_closed', 'The 24-hour service window has closed.');
  }

  return enqueue({
    ctx,
    agentId,
    byBot,
    type,
    body: caption ?? null,
    media: { link, caption, filename },
    job: { kind: 'media', type, link, caption, filename },
  });
}

/**
 * Writes the message row first (status 'queued') so the agent sees it in
 * the thread immediately, then hands off to the worker. The row is the
 * source of truth; the job is just delivery.
 */
async function enqueue({ ctx, agentId, byBot, type, body, media = null, job }) {
  const message = await tx(async (client) =>
    insertMessage(client, {
      tenantId: ctx.tenant_id,
      conversationId: ctx.conversation_id,
      direction: 'outbound',
      type,
      body,
      media,
      status: 'queued',
      sentByAgentId: agentId,
      sentByBot: byBot,
    })
  );

  await outboundQueue.add(
    'send',
    {
      messageId: message.id,
      tenantId: ctx.tenant_id,
      channelId: ctx.channel_id,
      toWaId: ctx.wa_id,
      byBot,
      ...job,
    },
    { jobId: message.id }
  );

  publish('message.queued', {
    tenantId: ctx.tenant_id,
    conversationId: ctx.conversation_id,
    message,
  });

  return message;
}