import { makeWorker, QUEUES, connection } from '../lib/queue.js';
import { query, one } from '../lib/db.js';
import { cloudApi } from '../channels/cloudApi.js';
import { publish } from '../lib/events.js';

/**
 * Per-channel throttle. Cloud API tolerates far more than this, but a
 * shared limiter keeps one client's burst from starving another's, and
 * gives us one obvious knob when a client needs a different ceiling.
 */
const MESSAGES_PER_SECOND = Number(process.env.SEND_RATE_PER_SECOND || 20);

async function takeToken(channelId) {
  const key = `ratelimit:send:${channelId}:${Math.floor(Date.now() / 1000)}`;
  const count = await connection.incr(key);
  if (count === 1) await connection.expire(key, 2);
  return count <= MESSAGES_PER_SECOND;
}

async function loadChannel(channelId) {
  return one(
    `SELECT id, tenant_id, phone_number_id, access_token_enc, status
       FROM channels WHERE id = $1`,
    [channelId]
  );
}

async function markFailed(messageId, err) {
  const { rows } = await query(
    `UPDATE messages
        SET status = 'failed',
            error = $2,
            updated_at = now()
      WHERE id = $1
      RETURNING conversation_id, tenant_id`,
    [
      messageId,
      JSON.stringify({
        message: err.message,
        status: err.status ?? null,
        detail: err.body?.error ?? null,
      }),
    ]
  );
  return rows[0];
}

async function handleSend(job, logger) {
  const { messageId, channelId, toWaId, kind } = job.data;

  if (!(await takeToken(channelId))) {
    // Not an error — put it back shortly. Throwing triggers BullMQ backoff.
    throw Object.assign(new Error('rate limited'), { retryable: true });
  }

  const channel = await loadChannel(channelId);
  if (!channel || channel.status !== 'active') {
    await markFailed(messageId, new Error('channel unavailable'));
    return { skipped: true };
  }

  let result;
  try {
    if (kind === 'text') {
      result = await cloudApi.sendText(channel, toWaId, job.data.text);
    } else if (kind === 'template') {
      result = await cloudApi.sendTemplate(channel, toWaId, {
        name: job.data.name,
        language: job.data.language,
        components: job.data.components,
      });
    } else if (kind === 'media') {
      result = await cloudApi.sendMedia(channel, toWaId, {
        type: job.data.type,
        link: job.data.link,
        caption: job.data.caption,
        filename: job.data.filename,
      });
    } else {
      throw new Error(`unknown send kind: ${kind}`);
    }
  } catch (err) {
    // Permanent failures must not be retried five times — a bad template
    // name or an invalid number will fail identically every attempt.
    if (err.retryable === false) {
      const row = await markFailed(messageId, err);
      if (row) {
        publish('message.status', {
          tenantId: row.tenant_id,
          conversationId: row.conversation_id,
          messageId,
          status: 'failed',
          error: err.message,
        });
      }
      logger.warn({ messageId, err: err.message }, 'permanent send failure');
      return { failed: true };
    }
    throw err;
  }

  const { rows } = await query(
    `UPDATE messages
        SET provider_message_id = $2,
            status = 'sent',
            updated_at = now()
      WHERE id = $1
      RETURNING conversation_id, tenant_id`,
    [messageId, result.providerMessageId]
  );

  const row = rows[0];
  if (row) {
    // Outbound resets the preview but never the window — only inbound
    // messages open the 24-hour service window.
    // A human reply starts the bot's quiet period; a bot reply does not.
    await query(
      `UPDATE conversations
          SET last_message_at = now(),
              last_message_preview = LEFT(COALESCE($2, ''), 160),
              last_human_reply_at = CASE WHEN $3 THEN now() ELSE last_human_reply_at END,
              updated_at = now()
        WHERE id = $1`,
      [
        row.conversation_id,
        job.data.text ?? job.data.caption ?? '[media]',
        job.data.byBot !== true,
      ]
    );

    publish('message.status', {
      tenantId: row.tenant_id,
      conversationId: row.conversation_id,
      messageId,
      status: 'sent',
      providerMessageId: result.providerMessageId,
    });
  }

  return { providerMessageId: result.providerMessageId };
}

export function startOutboundWorker(logger) {
  const worker = makeWorker(
    QUEUES.OUTBOUND,
    async (job) => handleSend(job, logger),
    { concurrency: 5 }
  );

  worker.on('failed', async (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, 'outbound job failed');

    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      const row = await markFailed(job.data.messageId, err).catch(() => null);
      if (row) {
        publish('message.status', {
          tenantId: row.tenant_id,
          conversationId: row.conversation_id,
          messageId: job.data.messageId,
          status: 'failed',
          error: err.message,
        });
      }
    }
  });

  return worker;
}