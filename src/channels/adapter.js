/**
 * ChannelAdapter — the single interface the rest of the app talks to.
 *
 * Nothing above this layer may know that WhatsApp Cloud API exists.
 * If we ever add Baileys, it implements this same shape and everything
 * else stays untouched.
 *
 * Normalized inbound message shape (what parseWebhook returns):
 *
 *   {
 *     phoneNumberId: string,      // routing key -> channel -> tenant
 *     messages: [{
 *       providerMessageId: string,
 *       from: string,             // wa_id
 *       profileName: string|null,
 *       type: string,
 *       body: string|null,
 *       media: object|null,
 *       timestamp: Date,
 *       raw: object
 *     }],
 *     statuses: [{
 *       providerMessageId: string,
 *       status: 'sent'|'delivered'|'read'|'failed',
 *       timestamp: Date,
 *       error: object|null,
 *       conversationCategory: string|null,
 *       conversationExpiresAt: Date|null
 *     }]
 *   }
 */
export class ChannelAdapter {
  /* eslint-disable no-unused-vars */

  /** @returns {Promise<{providerMessageId: string}>} */
  async sendText(channel, toWaId, text) {
    throw new Error('not implemented');
  }

  /** @returns {Promise<{providerMessageId: string}>} */
  async sendTemplate(channel, toWaId, { name, language, components }) {
    throw new Error('not implemented');
  }

  /** @returns {Promise<{providerMessageId: string}>} */
  async sendMedia(channel, toWaId, { type, link, caption, filename }) {
    throw new Error('not implemented');
  }

  /** Mark an inbound message as read (blue ticks on the customer's side). */
  async markRead(channel, providerMessageId) {
    throw new Error('not implemented');
  }

  /** Resolve a media id to a downloadable URL. */
  async getMediaUrl(channel, mediaId) {
    throw new Error('not implemented');
  }

  /** Normalize a raw provider webhook body. Pure function, no I/O. */
  parseWebhook(body) {
    throw new Error('not implemented');
  }
}