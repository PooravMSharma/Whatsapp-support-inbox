import { makeWorker, QUEUES } from '../lib/queue.js';
import { tx, query } from '../lib/db.js';
import {
  upsertContact,
  getOrCreateConversation,
  applyInbound,
  insertMessage,
  updateMessageStatus,
  recordConversationUsage,
} from '../repos/messaging.js';
import { publish } from '../lib/events.js';
import { handleInbound as runBot } from '../lib/bot.js';

async function handleMessage(job) {
  const { tenantId, channelId, payload, eventId } = job.data;

  const result = await tx(async (client) => {
    const contact = await upsertContact(client, {
      tenantId,
      waId: payload.from,
      profileName: payload.profileName,
    });

    const conversation = await getOrCreateConversation(client, {
      tenantId,
      channelId,
      contactId: contact.id,
    });

    const message = await insertMessage(client, {
      tenantId,
      conversationId: conversation.id,
      direction: 'inbound',
      providerMessageId: payload.providerMessageId,
      type: payload.type,
      body: payload.body,
      media: payload.media,
      raw: payload.raw,
      status: 'received',
      createdAt: payload.timestamp,
    });

    // insertMessage returns null when the unique index caught a duplicate.
    if (!message) return null;

    const updated = await applyInbound(client, {
      conversationId: conversation.id,
      preview: payload.body || `[${payload.type}]`,
      at: payload.timestamp,
    });

    await client.query(
      `UPDATE webhook_events SET processed_at = now() WHERE id = $1`,
      [eventId]
    );

    return { contact, conversation: updated, message };
  });

  if (!result) return { deduped: true };

  // Fan out to the realtime layer. The inbox picks this up.
  publish('message.received', {
    tenantId,
    conversationId: result.conversation.id,
    message: { ...result.message, raw: undefined },
    conversation: result.conversation,
    contact: result.contact,
  });

  // Automation runs after the message is safely stored and broadcast, so
  // a bot failure can never cost us an inbound message.
  const outcome = await runBot(
    {
      tenantId,
      conversationId: result.conversation.id,
      message: result.message,
    },
    job.log ? { error: (o, m) => job.log(m) } : undefined
  );

  return { messageId: result.message.id, bot: outcome };
}

async function handleStatus(job) {
  const { tenantId, channelId, payload, eventId } = job.data;

  const updated = await tx(async (client) => {
    const row = await updateMessageStatus(client, {
      providerMessageId: payload.providerMessageId,
      status: payload.status,
      error: payload.error,
    });

    // Meta tells us when a billable conversation opened.
    if (payload.conversationCategory && row) {
      await recordConversationUsage(client, {
        tenantId,
        channelId,
        conversationId: row.conversation_id,
        category: payload.conversationCategory,
        expiresAt: payload.conversationExpiresAt,
      });
    }

    await client.query(
      `UPDATE webhook_events SET processed_at = now() WHERE id = $1`,
      [eventId]
    );

    return row;
  });

  if (updated) {
    publish('message.status', {
      tenantId,
      conversationId: updated.conversation_id,
      messageId: updated.id,
      status: updated.status,
    });
  }

  return { updated: Boolean(updated) };
}

export function startInboundWorker(logger) {
  const worker = makeWorker(QUEUES.INBOUND, async (job) => {
    if (job.data.kind === 'message') return handleMessage(job);
    if (job.data.kind === 'status') return handleStatus(job);
    throw new Error(`Unknown inbound job kind: ${job.data.kind}`);
  });

  worker.on('failed', async (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, 'inbound job failed');
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      await query(
        `UPDATE webhook_events SET error = $2 WHERE id = $1`,
        [job.data.eventId, err.message]
      ).catch(() => {});
    }
  });

  return worker;
}