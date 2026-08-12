import { login, logout, requireAuth, bearerFrom } from '../lib/auth.js';
import * as inbox from '../repos/inbox.js';
import { publish } from '../lib/events.js';
import { sendText, sendTemplate, sendMedia, SendError } from '../lib/send.js';
import { listTemplates, syncTemplates } from '../repos/templates.js';
import * as botRepo from '../repos/bot.js';
import { selectRule, isWithinBusinessHours } from '../lib/bot.js';
import * as kb from '../repos/kb.js';
import { answerFromKnowledge } from '../lib/rag.js';
import { health as ollamaHealth } from '../lib/ollama.js';
import { one } from '../lib/db.js';

export async function authRoutes(app) {
  app.post('/api/auth/login', async (req, reply) => {
    const { email, password, tenant } = req.body || {};
    if (!email || !password || !tenant) {
      return reply.code(400).send({ error: 'email, password and tenant are required' });
    }

    const result = await login({ email, password, tenantSlug: tenant });
    if (!result) return reply.code(401).send({ error: 'invalid credentials' });

    return result;
  });

  app.post('/api/auth/logout', async (req) => {
    await logout(bearerFrom(req));
    return { ok: true };
  });
}

export async function inboxRoutes(app) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/me', async (req) => ({
    agentId: req.auth.agent_id,
    tenantId: req.auth.tenant_id,
    name: req.auth.name,
    email: req.auth.email,
    role: req.auth.role,
  }));

  app.get('/api/agents', async (req) =>
    inbox.listAgents({ tenantId: req.auth.tenant_id })
  );

  app.get('/api/counts', async (req) =>
    inbox.inboxCounts({
      tenantId: req.auth.tenant_id,
      agentId: req.auth.agent_id,
    })
  );

  app.get('/api/conversations', async (req) => {
    const { filter = 'all', limit = '50', cursor } = req.query;
    const rows = await inbox.listConversations({
      tenantId: req.auth.tenant_id,
      agentId: req.auth.agent_id,
      filter,
      limit: Math.min(Number(limit) || 50, 100),
      cursor,
    });
    return {
      conversations: rows,
      nextCursor: rows.length ? rows[rows.length - 1].last_message_at : null,
    };
  });

  app.get('/api/conversations/:id', async (req, reply) => {
    const conversation = await inbox.getConversation({
      tenantId: req.auth.tenant_id,
      conversationId: req.params.id,
    });
    if (!conversation) return reply.code(404).send({ error: 'not found' });
    return conversation;
  });

  app.get('/api/conversations/:id/messages', async (req) => {
    const { limit = '50', before } = req.query;
    const rows = await inbox.listMessages({
      tenantId: req.auth.tenant_id,
      conversationId: req.params.id,
      limit: Math.min(Number(limit) || 50, 100),
      before,
    });
    return {
      messages: rows.reverse(), // oldest first for rendering
      nextBefore: rows.length ? rows[0].created_at : null,
    };
  });

  app.post('/api/conversations/:id/assign', async (req, reply) => {
    // agentId null unassigns; omitted means assign to self.
    const agentId =
      req.body && 'agentId' in req.body ? req.body.agentId : req.auth.agent_id;

    const row = await inbox.assignConversation({
      tenantId: req.auth.tenant_id,
      conversationId: req.params.id,
      agentId,
    });
    if (!row) return reply.code(404).send({ error: 'not found' });

    // Taking a conversation pauses the bot so automation does not talk
    // over the agent. Return the row AFTER the pause, not before.
    let current = row;
    if (agentId) {
      current = await inbox.setBotPause({
        tenantId: req.auth.tenant_id,
        conversationId: req.params.id,
        minutes: 60,
      });
    }

    publish('conversation.updated', {
      tenantId: req.auth.tenant_id,
      conversationId: current.id,
    });
    return current;
  });

  app.post('/api/conversations/:id/status', async (req, reply) => {
    const { status } = req.body || {};
    if (!['open', 'pending', 'resolved'].includes(status)) {
      return reply.code(400).send({ error: 'status must be open, pending or resolved' });
    }
    const row = await inbox.setStatus({
      tenantId: req.auth.tenant_id,
      conversationId: req.params.id,
      status,
    });
    if (!row) return reply.code(404).send({ error: 'not found' });

    publish('conversation.updated', {
      tenantId: req.auth.tenant_id,
      conversationId: row.id,
    });
    return row;
  });

  app.post('/api/conversations/:id/read', async (req, reply) => {
    const row = await inbox.markRead({
      tenantId: req.auth.tenant_id,
      conversationId: req.params.id,
    });
    if (!row) return reply.code(404).send({ error: 'not found' });

    publish('conversation.updated', {
      tenantId: req.auth.tenant_id,
      conversationId: row.id,
    });
    return row;
  });

  app.post('/api/conversations/:id/bot', async (req, reply) => {
    const { pauseMinutes = null } = req.body || {};
    const row = await inbox.setBotPause({
      tenantId: req.auth.tenant_id,
      conversationId: req.params.id,
      minutes: pauseMinutes,
    });
    if (!row) return reply.code(404).send({ error: 'not found' });
    return row;
  });

  // -----------------------------------------------------------------
  // Sending. Every path here goes through lib/send.js, which is the
  // only place allowed to touch the channel adapter.
  // -----------------------------------------------------------------

  app.post('/api/conversations/:id/messages', async (req, reply) => {
    const { text, template, media } = req.body || {};

    try {
      let message;

      if (template) {
        message = await sendTemplate({
          tenantId: req.auth.tenant_id,
          conversationId: req.params.id,
          name: template.name,
          language: template.language,
          variables: template.variables ?? {},
          agentId: req.auth.agent_id,
        });
      } else if (media) {
        message = await sendMedia({
          tenantId: req.auth.tenant_id,
          conversationId: req.params.id,
          type: media.type,
          link: media.link,
          caption: media.caption,
          filename: media.filename,
          agentId: req.auth.agent_id,
        });
      } else {
        message = await sendText({
          tenantId: req.auth.tenant_id,
          conversationId: req.params.id,
          text,
          agentId: req.auth.agent_id,
        });
      }

      // Replying implies you have read the thread.
      await inbox.markRead({
        tenantId: req.auth.tenant_id,
        conversationId: req.params.id,
      });

      return reply.code(202).send(message);
    } catch (err) {
      if (err instanceof SendError) {
        const status = err.code === 'not_found' ? 404 : 422;
        return reply.code(status).send({ error: err.code, message: err.message, ...err.extra });
      }
      throw err;
    }
  });

  app.get('/api/templates', async (req) =>
    listTemplates({
      tenantId: req.auth.tenant_id,
      approvedOnly: req.query.approved === 'true',
    })
  );

  app.post('/api/templates/sync', async (req, reply) => {
    if (!['owner', 'admin'].includes(req.auth.role)) {
      return reply.code(403).send({ error: 'admins only' });
    }

    const channel = await one(
      `SELECT * FROM channels WHERE tenant_id = $1 AND status = 'active' LIMIT 1`,
      [req.auth.tenant_id]
    );
    if (!channel) return reply.code(404).send({ error: 'no active channel' });

    try {
      const count = await syncTemplates(channel);
      return { synced: count };
    } catch (err) {
      return reply.code(502).send({ error: 'sync_failed', message: err.message });
    }
  });

  // -----------------------------------------------------------------
  // Automation
  // -----------------------------------------------------------------

  function adminOnly(req, reply) {
    if (!['owner', 'admin'].includes(req.auth.role)) {
      reply.code(403).send({ error: 'admins only' });
      return false;
    }
    return true;
  }

  app.get('/api/bot/settings', async (req) => {
    const settings = await botRepo.getSettings(req.auth.tenant_id);
    return {
      ...settings,
      openNow: isWithinBusinessHours(settings.business_hours),
    };
  });

  app.put('/api/bot/settings', async (req, reply) => {
    if (!adminOnly(req, reply)) return;
    return botRepo.updateSettings(req.auth.tenant_id, req.body || {});
  });

  app.get('/api/bot/rules', async (req) => botRepo.listRules(req.auth.tenant_id));

  app.post('/api/bot/rules', async (req, reply) => {
    if (!adminOnly(req, reply)) return;
    const r = req.body || {};
    if (!r.name) return reply.code(400).send({ error: 'name is required' });
    if (r.action !== 'escalate' && !r.replyText) {
      return reply.code(400).send({ error: 'reply rules need reply text' });
    }
    if (['keyword', 'exact'].includes(r.matchType ?? 'keyword') && !r.keywords?.length) {
      return reply.code(400).send({ error: 'add at least one keyword' });
    }
    return reply.code(201).send(await botRepo.createRule(req.auth.tenant_id, r));
  });

  app.put('/api/bot/rules/:id', async (req, reply) => {
    if (!adminOnly(req, reply)) return;
    const row = await botRepo.updateRule(req.auth.tenant_id, req.params.id, req.body || {});
    if (!row) return reply.code(404).send({ error: 'not found' });
    return row;
  });

  app.delete('/api/bot/rules/:id', async (req, reply) => {
    if (!adminOnly(req, reply)) return;
    const ok = await botRepo.deleteRule(req.auth.tenant_id, req.params.id);
    if (!ok) return reply.code(404).send({ error: 'not found' });
    return { deleted: true };
  });

  app.get('/api/bot/stats', async (req) => botRepo.botStats(req.auth.tenant_id));

  /**
   * Dry run. Answers "what would the bot say to this?" without sending,
   * so rules can be tuned against real phrasing safely.
   */
  app.post('/api/bot/test', async (req, reply) => {
    const { text } = req.body || {};
    if (!text) return reply.code(400).send({ error: 'text is required' });

    const settings = await botRepo.getSettings(req.auth.tenant_id);
    const rules = await botRepo.listRules(req.auth.tenant_id, { activeOnly: true });
    const rule = await selectRule(rules, { text, isFirst: false });

    return {
      enabled: settings.enabled,
      openNow: isWithinBusinessHours(settings.business_hours),
      matched: rule ? { id: rule.id, name: rule.name, action: rule.action } : null,
      wouldSend: rule?.reply_text
        ?? (isWithinBusinessHours(settings.business_hours) ? null : settings.off_hours_reply),
    };
  });

  // -----------------------------------------------------------------
  // Knowledge base + retrieval
  // -----------------------------------------------------------------

  app.get('/api/kb/health', async () => ollamaHealth());

  app.get('/api/kb/documents', async (req) => kb.listDocuments(req.auth.tenant_id));

  app.post('/api/kb/documents', async (req, reply) => {
    if (!adminOnly(req, reply)) return;
    const { title, content, filename } = req.body || {};
    if (!title || !content?.trim()) {
      return reply.code(400).send({ error: 'title and content are required' });
    }

    const doc = await kb.createDocument(req.auth.tenant_id, {
      title,
      content,
      sourceType: filename ? 'file' : 'paste',
      filename,
    });

    // Index inline. Embedding a business document takes seconds on a
    // local model, and a synchronous result is far easier to debug than
    // a background job that silently fails.
    try {
      const { chunks } = await kb.indexDocument(req.auth.tenant_id, doc.id);
      return reply.code(201).send({ ...doc, chunk_count: chunks, status: 'indexed' });
    } catch (err) {
      return reply.code(502).send({
        error: 'index_failed',
        message: err.message,
        documentId: doc.id,
      });
    }
  });

  app.post('/api/kb/documents/:id/reindex', async (req, reply) => {
    if (!adminOnly(req, reply)) return;
    try {
      const { chunks } = await kb.indexDocument(req.auth.tenant_id, req.params.id);
      return { indexed: chunks };
    } catch (err) {
      return reply.code(502).send({ error: 'index_failed', message: err.message });
    }
  });

  app.delete('/api/kb/documents/:id', async (req, reply) => {
    if (!adminOnly(req, reply)) return;
    const ok = await kb.deleteDocument(req.auth.tenant_id, req.params.id);
    if (!ok) return reply.code(404).send({ error: 'not found' });
    return { deleted: true };
  });

  /** What would retrieval find? No model call, no sending. */
  app.post('/api/kb/search', async (req, reply) => {
    const { query: q, topK } = req.body || {};
    if (!q) return reply.code(400).send({ error: 'query is required' });
    try {
      const chunks = await kb.retrieve(req.auth.tenant_id, q, {
        topK: Math.min(Number(topK) || 5, 20),
      });
      return { results: chunks.map((c) => ({
        score: Number(c.score.toFixed(3)),
        title: c.title,
        content: c.content,
      })) };
    } catch (err) {
      return reply.code(502).send({ error: 'search_failed', message: err.message });
    }
  });

  /** Full dry run: retrieve, generate, but never send. */
  app.post('/api/kb/ask', async (req, reply) => {
    const { question } = req.body || {};
    if (!question) return reply.code(400).send({ error: 'question is required' });

    const settings = await botRepo.getSettings(req.auth.tenant_id);
    const result = await answerFromKnowledge({
      tenantId: req.auth.tenant_id,
      question,
      minScore: settings.rag_min_score,
      topK: settings.rag_top_k,
      systemPromptExtra: settings.rag_system_prompt,
    });

    return {
      outcome: result.outcome,
      answer: result.text ?? null,
      topScore: result.topScore != null ? Number(result.topScore.toFixed(3)) : null,
      error: result.error ?? null,
      usedChunks: (result.chunks ?? []).map((c) => ({
        score: Number(c.score.toFixed(3)),
        title: c.title,
        preview: c.content.slice(0, 120),
      })),
    };
  });

  app.get('/api/kb/stats', async (req) => kb.ragStats(req.auth.tenant_id));
}