import { request } from 'undici';
import { many, one, query } from '../lib/db.js';
import { config } from '../config.js';
import { decrypt } from '../lib/crypto.js';

/**
 * Templates live in Meta's system; we mirror them so the send path can
 * check approval status without a network round trip on every message.
 */

export async function listTemplates({ tenantId, approvedOnly = false }) {
  return many(
    `SELECT id, name, language, category, status, components, synced_at
       FROM templates
      WHERE tenant_id = $1
        ${approvedOnly ? `AND status = 'APPROVED'` : ''}
      ORDER BY name, language`,
    [tenantId]
  );
}

export async function findTemplate({ tenantId, name, language }) {
  return one(
    `SELECT * FROM templates
      WHERE tenant_id = $1 AND name = $2 AND language = $3`,
    [tenantId, name, language]
  );
}

/**
 * Pull the template list from Meta and upsert it.
 * Approval status changes on Meta's side without warning, so this should
 * run on a schedule, not just on demand.
 */
export async function syncTemplates({ tenant_id, id: channelId, waba_id, access_token_enc }) {
  if (!waba_id) {
    throw new Error('channel has no waba_id; cannot sync templates');
  }

  const url =
    `${config.meta.graphBase}/${config.meta.graphVersion}` +
    `/${waba_id}/message_templates?limit=200`;

  const res = await request(url, {
    headers: { authorization: `Bearer ${decrypt(access_token_enc)}` },
  });
  const body = await res.body.json();

  if (res.statusCode >= 400) {
    throw new Error(body?.error?.message || 'template sync failed');
  }

  let count = 0;
  for (const t of body.data ?? []) {
    await query(
      `INSERT INTO templates
         (tenant_id, channel_id, name, language, category, status, components, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now())
       ON CONFLICT (channel_id, name, language) DO UPDATE
         SET status = EXCLUDED.status,
             category = EXCLUDED.category,
             components = EXCLUDED.components,
             synced_at = now()`,
      [
        tenant_id,
        channelId,
        t.name,
        t.language,
        t.category ?? null,
        t.status ?? 'PENDING',
        JSON.stringify(t.components ?? []),
      ]
    );
    count += 1;
  }

  return count;
}

/**
 * Meta expects template variables positionally. Turn
 * { body: ['Poorav', '123'] } into the components array it wants.
 */
export function buildTemplateComponents({ header = [], body = [], buttons = [] }) {
  const components = [];

  if (header.length) {
    components.push({
      type: 'header',
      parameters: header.map((text) => ({ type: 'text', text: String(text) })),
    });
  }
  if (body.length) {
    components.push({
      type: 'body',
      parameters: body.map((text) => ({ type: 'text', text: String(text) })),
    });
  }
  buttons.forEach((param, index) => {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: String(index),
      parameters: [{ type: 'text', text: String(param) }],
    });
  });

  return components;
}