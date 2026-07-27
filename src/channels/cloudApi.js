import { request } from 'undici';
import { ChannelAdapter } from './adapter.js';
import { config } from '../config.js';
import { decrypt } from '../lib/crypto.js';

const GRAPH = `${config.meta.graphBase}/${config.meta.graphVersion}`;

class CloudApiError extends Error {
  constructor(message, { status, body }) {
    super(message);
    this.name = 'CloudApiError';
    this.status = status;
    this.body = body;
    // 4xx other than 429 are permanent — the worker should not retry these.
    this.retryable = status === 429 || status >= 500;
  }
}

export class CloudApiAdapter extends ChannelAdapter {
  #token(channel) {
    return decrypt(channel.access_token_enc);
  }

  async #post(channel, path, payload) {
    const res = await request(`${GRAPH}/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.#token(channel)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const body = await res.body.json().catch(() => ({}));
    if (res.statusCode >= 400) {
      const detail = body?.error?.message || 'Cloud API request failed';
      throw new CloudApiError(detail, { status: res.statusCode, body });
    }
    return body;
  }

  async #send(channel, toWaId, message) {
    const body = await this.#post(channel, `${channel.phone_number_id}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toWaId,
      ...message,
    });
    return { providerMessageId: body?.messages?.[0]?.id ?? null };
  }

  async sendText(channel, toWaId, text) {
    return this.#send(channel, toWaId, {
      type: 'text',
      text: { preview_url: true, body: text },
    });
  }

  async sendTemplate(channel, toWaId, { name, language, components = [] }) {
    return this.#send(channel, toWaId, {
      type: 'template',
      template: { name, language: { code: language }, components },
    });
  }

  async sendMedia(channel, toWaId, { type, link, caption, filename }) {
    const media = { link };
    if (caption && ['image', 'video', 'document'].includes(type)) media.caption = caption;
    if (filename && type === 'document') media.filename = filename;
    return this.#send(channel, toWaId, { type, [type]: media });
  }

  async markRead(channel, providerMessageId) {
    await this.#post(channel, `${channel.phone_number_id}/messages`, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: providerMessageId,
    });
  }

  async getMediaUrl(channel, mediaId) {
    const res = await request(`${GRAPH}/${mediaId}`, {
      headers: { authorization: `Bearer ${this.#token(channel)}` },
    });
    const body = await res.body.json();
    if (res.statusCode >= 400) {
      throw new CloudApiError('Failed to resolve media', {
        status: res.statusCode,
        body,
      });
    }
    return body.url;
  }

  // -------------------------------------------------------------
  // Webhook normalization. Pure — no network, no database.
  // -------------------------------------------------------------
  parseWebhook(body) {
    const out = [];

    for (const entry of body?.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages') continue;
        const value = change.value || {};
        const phoneNumberId = value.metadata?.phone_number_id;
        if (!phoneNumberId) continue;

        const profileNames = new Map(
          (value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name ?? null])
        );

        const messages = (value.messages ?? []).map((m) => ({
          providerMessageId: m.id,
          from: m.from,
          profileName: profileNames.get(m.from) ?? null,
          type: m.type,
          body: extractBody(m),
          media: extractMedia(m),
          timestamp: new Date(Number(m.timestamp) * 1000),
          raw: m,
        }));

        const statuses = (value.statuses ?? []).map((s) => ({
          providerMessageId: s.id,
          status: s.status,
          timestamp: new Date(Number(s.timestamp) * 1000),
          error: s.errors?.[0] ?? null,
          conversationCategory: s.conversation?.origin?.type ?? null,
          conversationExpiresAt: s.conversation?.expiration_timestamp
            ? new Date(Number(s.conversation.expiration_timestamp) * 1000)
            : null,
        }));

        out.push({ phoneNumberId, messages, statuses });
      }
    }

    return out;
  }
}

function extractBody(m) {
  switch (m.type) {
    case 'text':
      return m.text?.body ?? null;
    case 'button':
      return m.button?.text ?? null;
    case 'interactive':
      return (
        m.interactive?.button_reply?.title ??
        m.interactive?.list_reply?.title ??
        null
      );
    case 'image':
    case 'video':
    case 'document':
      return m[m.type]?.caption ?? null;
    case 'location':
      return m.location?.name ?? 'Shared a location';
    default:
      return null;
  }
}

function extractMedia(m) {
  const mediaTypes = ['image', 'video', 'audio', 'document', 'sticker'];
  if (!mediaTypes.includes(m.type)) return null;
  const media = m[m.type] || {};
  return {
    id: media.id ?? null,
    mimeType: media.mime_type ?? null,
    sha256: media.sha256 ?? null,
    filename: media.filename ?? null,
    caption: media.caption ?? null,
  };
}

export const cloudApi = new CloudApiAdapter();