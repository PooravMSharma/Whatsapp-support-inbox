import { tx, one } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { upsertContact, getOrCreateConversation } from '../repos/messaging.js';
import { sendTemplate, SendError } from '../lib/send.js';
import { findTemplate } from '../repos/templates.js';

/**
 * Outbound API for other applications.
 *
 * The inbox API is written for agents, who work in terms of
 * conversations. An external app (a booking system, a shop, a CRM) knows
 * only a phone number, so this route resolves the number to a contact and
 * conversation first, then hands off to the SAME guarded send path
 * everything else uses. No shortcuts around the window and template
 * rules.
 *
 * Lives in its own file because integrations outlive refactors of the
 * agent-facing API.
 */

function normalizeWaId(input) {
  // Meta wants E.164 without '+' or separators: 919950065105
  const digits = String(input || '').replace(/[^\d]/g, '');
  if (digits.length < 10) return null;
  // Bare Indian 10-digit numbers are a common input; assume +91.
  if (digits.length === 10) return '91' + digits;
  return digits;
}

export async function sendApiRoutes(app) {
  app.addHook('preHandler', requireAuth);

  /**
   * POST /api/send/template
   *
   *   {
   *     "to": "+91 99500 65105",
   *     "name": "booking_confirmation",
   *     "language": "en",
   *     "variables": { "body": ["Poorav", "3pm", "Tuesday"] },
   *     "profileName": "Poorav Sharma"        // optional
   *   }
   *
   * Templates are the right primitive here: an external app sends
   * business-initiated messages, which WhatsApp only permits as approved
   * templates outside the 24-hour window.
   */
  app.post('/api/send/template', async (req, reply) => {
    const { to, name, language = 'en', variables = {}, profileName } = req.body || {};

    if (!to || !name) {
      return reply.code(400).send({
        error: 'bad_request',
        message: '"to" and "name" are required',
      });
    }

    const waId = normalizeWaId(to);
    if (!waId) {
      return reply.code(400).send({
        error: 'bad_number',
        message: `Could not parse "${to}" as a phone number`,
      });
    }

    const tenantId = req.auth.tenant_id;

    // Fail before creating anything if the template is unusable. This is
    // what stops a bad template name from littering the inbox with empty
    // conversations.
    const template = await findTemplate({ tenantId, name, language });
    if (!template) {
      return reply.code(404).send({
        error: 'template_not_found',
        message: `No template "${name}" in language "${language}". ` +
                 `Run POST /api/templates/sync if it was just approved.`,
      });
    }
    if (template.status !== 'APPROVED') {
      return reply.code(422).send({
        error: 'template_not_approved',
        message: `Template "${name}" is ${template.status}`,
      });
    }

    const channel = await one(
      `SELECT id FROM channels
        WHERE tenant_id = $1 AND status = 'active'
        ORDER BY created_at
        LIMIT 1`,
      [tenantId]
    );
    if (!channel) {
      return reply.code(503).send({
        error: 'no_active_channel',
        message: 'This workspace has no active WhatsApp number',
      });
    }

    const { conversation } = await tx(async (client) => {
      const contact = await upsertContact(client, {
        tenantId,
        waId,
        profileName: profileName ?? null,
      });
      const conversation = await getOrCreateConversation(client, {
        tenantId,
        channelId: channel.id,
        contactId: contact.id,
      });
      return { contact, conversation };
    });

    try {
      const message = await sendTemplate({
        tenantId,
        conversationId: conversation.id,
        name,
        language,
        variables,
        byBot: true,
      });

      return reply.code(202).send({
        messageId: message.id,
        conversationId: conversation.id,
        waId,
        status: message.status,
      });
    } catch (err) {
      if (err instanceof SendError) {
        return reply.code(422).send({
          error: err.code,
          message: err.message,
          conversationId: conversation.id,
          ...err.extra,
        });
      }
      throw err;
    }
  });

  /**
   * POST /api/send/text
   *
   * Free-form text, only valid inside the 24-hour window. Useful when an
   * external app is continuing a conversation the customer started.
   */
  app.post('/api/send/text', async (req, reply) => {
    const { to, text, profileName } = req.body || {};

    if (!to || !text?.trim()) {
      return reply.code(400).send({
        error: 'bad_request',
        message: '"to" and "text" are required',
      });
    }

    const waId = normalizeWaId(to);
    if (!waId) {
      return reply.code(400).send({ error: 'bad_number' });
    }

    const tenantId = req.auth.tenant_id;

    const channel = await one(
      `SELECT id FROM channels
        WHERE tenant_id = $1 AND status = 'active'
        ORDER BY created_at LIMIT 1`,
      [tenantId]
    );
    if (!channel) return reply.code(503).send({ error: 'no_active_channel' });

    const { conversation } = await tx(async (client) => {
      const contact = await upsertContact(client, {
        tenantId, waId, profileName: profileName ?? null,
      });
      const conversation = await getOrCreateConversation(client, {
        tenantId, channelId: channel.id, contactId: contact.id,
      });
      return { contact, conversation };
    });

    try {
      const { sendText } = await import('../lib/send.js');
      const message = await sendText({
        tenantId,
        conversationId: conversation.id,
        text,
        byBot: true,
      });

      return reply.code(202).send({
        messageId: message.id,
        conversationId: conversation.id,
        waId,
        status: message.status,
      });
    } catch (err) {
      if (err instanceof SendError) {
        return reply.code(422).send({
          error: err.code,
          message: err.message,
          conversationId: conversation.id,
          ...err.extra,
        });
      }
      throw err;
    }
  });

  /** Cheap check that an integration's credentials still work. */
  app.get('/api/send/ping', async (req) => ({
    ok: true,
    tenantId: req.auth.tenant_id,
    agent: req.auth.name,
  }));
}