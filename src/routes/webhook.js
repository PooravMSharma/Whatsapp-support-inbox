import crypto from 'node:crypto';
import { config } from '../config.js';
import { verifyMetaSignature } from '../lib/crypto.js';
import { query, one } from '../lib/db.js';
import { inboundQueue } from '../lib/queue.js';
import { cloudApi } from '../channels/cloudApi.js';

/**
 * Meta sends every webhook for the whole app to this ONE url.
 * We dispatch to a tenant using the phone_number_id inside the payload.
 *
 * Contract with Meta: return 200 fast. Anything slow or throwing here
 * causes retries and duplicate delivery. So: verify, persist, queue, ACK.
 */
export async function webhookRoutes(app) {
  // ---- GET: one-time subscription handshake -------------------
  app.get('/webhooks/meta', async (req, reply) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === config.meta.verifyToken) {
      return reply.code(200).send(challenge);
    }
    return reply.code(403).send('Forbidden');
  });

  // ---- POST: the actual events --------------------------------
  app.post('/webhooks/meta', async (req, reply) => {
    const raw = req.rawBody;

    if (!verifyMetaSignature(raw, req.headers['x-hub-signature-256'], config.meta.appSecret)) {
      req.log.warn('Rejected webhook with bad signature');
      return reply.code(401).send();
    }

    // ACK first in spirit: everything below is cheap and bounded.
    const parsed = cloudApi.parseWebhook(req.body);

    for (const batch of parsed) {
      const channel = await one(
        `SELECT c.id, c.tenant_id, c.status
           FROM channels c
          WHERE c.phone_number_id = $1`,
        [batch.phoneNumberId]
      );

      if (!channel) {
        req.log.warn({ phoneNumberId: batch.phoneNumberId }, 'Webhook for unknown number');
        continue;
      }

      const events = [
        ...batch.messages.map((m) => ({ kind: 'message', payload: m })),
        ...batch.statuses.map((s) => ({ kind: 'status', payload: s })),
      ];

      for (const event of events) {
        const dedupeKey = makeDedupeKey(batch.phoneNumberId, event);

        // The unique index does the deduping. If it's already there,
        // Meta redelivered and we drop it silently.
        const inserted = await one(
          `INSERT INTO webhook_events (dedupe_key, phone_number_id, tenant_id, payload)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (dedupe_key) DO NOTHING
           RETURNING id`,
          [dedupeKey, batch.phoneNumberId, channel.tenant_id, JSON.stringify(event)]
        );

        if (!inserted) continue;

        await inboundQueue.add(
          event.kind,
          {
            eventId: inserted.id,
            kind: event.kind,
            tenantId: channel.tenant_id,
            channelId: channel.id,
            payload: event.payload,
          },
          { jobId: dedupeKey }
        );
      }
    }

    return reply.code(200).send();
  });
}

function makeDedupeKey(phoneNumberId, event) {
  const id = event.payload.providerMessageId || 'unknown';
  const suffix =
    event.kind === 'status'
      ? `${event.payload.status}:${event.payload.timestamp.getTime()}`
      : 'msg';
  const key = `${phoneNumberId}:${id}:${suffix}`;
  // Keep it bounded for the unique index.
  return crypto.createHash('sha256').update(key).digest('hex');
}