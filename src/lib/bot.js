import { one, query } from '../lib/db.js';
import * as bot from '../repos/bot.js';
import { sendText, SendError } from './send.js';
import { answerFromKnowledge } from './rag.js';
import { publish } from './events.js';

/**
 * The automation layer.
 *
 * Its job is mostly to decide NOT to reply. An auto-responder that talks
 * over an agent, answers the same question five times, or messages someone
 * at 3am does more damage than no bot at all — so every guard below runs
 * before any rule is even considered.
 */

function normalize(text) {
  return (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Whole-word containment, so "hi" does not match "this". */
function containsWord(haystack, needle) {
  const n = normalize(needle);
  if (!n) return false;
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\W)${escaped}($|\\W)`, 'i').test(haystack);
}

export function isWithinBusinessHours(hours, now = new Date()) {
  try {
    const tz = hours?.timezone || 'Asia/Kolkata';
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now);

    const get = (t) => parts.find((p) => p.type === t)?.value;
    const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const day = dayMap[get('weekday')];
    const minutes = Number(get('hour')) * 60 + Number(get('minute'));

    const days = hours?.days ?? [1, 2, 3, 4, 5];
    if (!days.includes(day)) return false;

    const toMin = (s) => {
      const [h, m] = String(s).split(':').map(Number);
      return h * 60 + m;
    };
    return minutes >= toMin(hours?.open ?? '09:00')
        && minutes < toMin(hours?.close ?? '18:00');
  } catch {
    // A bad timezone should not silence the bot entirely.
    return true;
  }
}

/** Pick the first matching rule. Order is priority, then creation. */
export async function selectRule(rules, { text, isFirst }) {
  const body = normalize(text);

  for (const rule of rules) {
    // 'rag' and 'fallback' are last resorts, handled after this loop.
    if (rule.match_type === 'rag' || rule.match_type === 'fallback') continue;
    if (rule.match_type === 'greeting' && isFirst) return rule;
    if (rule.match_type === 'exact'
        && rule.keywords.some((k) => normalize(k) === body)) return rule;
    if (rule.match_type === 'keyword'
        && rule.keywords.some((k) => containsWord(body, k))) return rule;
  }
  // Retrieval gets the long tail before the blunt fallback does.
  return rules.find((r) => r.match_type === 'rag')
      ?? rules.find((r) => r.match_type === 'fallback')
      ?? null;
}

/**
 * Called by the inbound worker after a message is stored.
 * Returns a short outcome string, always — the caller never needs to
 * handle a throw, because a broken bot must not break message ingestion.
 */
export async function handleInbound({ tenantId, conversationId, message }, logger) {
  try {
    const settings = await bot.getSettings(tenantId);
    if (!settings.enabled) return skip('disabled');

    // Only text-like messages. An image with no caption has nothing to match.
    if (!message.body || !['text', 'button', 'interactive'].includes(message.type)) {
      return skip('not_text');
    }

    const conv = await one(
      `SELECT id, status, assigned_agent_id, bot_paused_until,
              last_human_reply_at, (window_expires_at > now()) AS window_open
         FROM conversations WHERE id = $1`,
      [conversationId]
    );
    if (!conv) return skip('no_conversation');

    // --- the guards, in order of how badly it would look to get them wrong

    if (conv.bot_paused_until && new Date(conv.bot_paused_until) > new Date()) {
      return skip('bot_paused');
    }

    if (conv.last_human_reply_at) {
      const graceMs = settings.human_grace_minutes * 60000;
      if (Date.now() - new Date(conv.last_human_reply_at) < graceMs) {
        return skip('human_recently_replied');
      }
    }

    if (!conv.window_open) return skip('window_closed');

    const recent = await bot.repliesInLastHour(conversationId);
    if (recent >= settings.max_replies_per_hour) return skip('rate_limited');

    // --- off hours

    if (!isWithinBusinessHours(settings.business_hours)) {
      if (!settings.off_hours_reply) return skip('off_hours_silent');
      const sent = await deliver({
        tenantId, conversationId, text: settings.off_hours_reply,
      });
      await bot.logReply({
        tenantId, conversationId, ruleId: null,
        inboundMessageId: message.id, outboundMessageId: sent?.id,
        outcome: 'replied',
      });
      return 'replied:off_hours';
    }

    // --- rules

    const rules = await bot.listRules(tenantId, { activeOnly: true });
    if (!rules.length) return skip('no_rules');

    const isFirst = await bot.isFirstMessage(conversationId, message.id);
    const rule = await selectRule(rules, { text: message.body, isFirst });
    if (!rule) return skip('no_match');

    await bot.recordHit(rule.id);

    if (rule.action === 'escalate') {
      await query(
        `UPDATE conversations
            SET status = 'pending',
                assigned_agent_id = COALESCE($2, assigned_agent_id),
                bot_paused_until = now() + ($3 || ' minutes')::interval,
                updated_at = now()
          WHERE id = $1`,
        [conversationId, rule.assign_to_agent_id, String(rule.pause_minutes)]
      );

      let sent = null;
      if (rule.reply_text) {
        sent = await deliver({ tenantId, conversationId, text: rule.reply_text });
      }

      await bot.logReply({
        tenantId, conversationId, ruleId: rule.id,
        inboundMessageId: message.id, outboundMessageId: sent?.id,
        outcome: 'escalated',
      });

      publish('conversation.updated', { tenantId, conversationId });
      return 'escalated';
    }

    // --- retrieval-augmented answer

    if (rule.match_type === 'rag') {
      const result = await answerFromKnowledge({
        tenantId,
        conversationId,
        question: message.body,
        minScore: settings.rag_min_score,
        topK: settings.rag_top_k,
        systemPromptExtra: settings.rag_system_prompt,
      });

      if (result.outcome === 'answered') {
        const sent = await deliver({ tenantId, conversationId, text: result.text });
        await bot.logReply({
          tenantId, conversationId, ruleId: rule.id,
          inboundMessageId: message.id, outboundMessageId: sent?.id,
          outcome: 'replied',
        });
        return 'replied:rag';
      }

      // Retrieval could not ground an answer, or Ollama is down. Either
      // way a human takes it — with a holding message so the customer is
      // not left staring at silence.
      await query(
        `UPDATE conversations
            SET status = 'pending',
                bot_paused_until = now() + ($2 || ' minutes')::interval,
                updated_at = now()
          WHERE id = $1`,
        [conversationId, String(rule.pause_minutes)]
      );

      let sent = null;
      if (rule.reply_text) {
        sent = await deliver({ tenantId, conversationId, text: rule.reply_text });
      }

      await bot.logReply({
        tenantId, conversationId, ruleId: rule.id,
        inboundMessageId: message.id, outboundMessageId: sent?.id,
        outcome: 'escalated',
      });

      publish('conversation.updated', { tenantId, conversationId });
      return 'escalated:' + result.outcome;
    }

    if (!rule.reply_text) return skip('rule_has_no_text');

    const sent = await deliver({ tenantId, conversationId, text: rule.reply_text });
    await bot.logReply({
      tenantId, conversationId, ruleId: rule.id,
      inboundMessageId: message.id, outboundMessageId: sent?.id,
      outcome: 'replied',
    });
    return 'replied';

    function skip(reason) {
      // Skips are logged without an outbound id, so they do not count
      // against the rate limit but are still visible when tuning rules.
      bot.logReply({
        tenantId, conversationId, ruleId: null,
        inboundMessageId: message.id, outcome: 'skipped:' + reason,
      }).catch(() => {});
      return 'skipped:' + reason;
    }
  } catch (err) {
    logger?.error({ err: err.message, conversationId }, 'bot failed');
    return 'error';
  }
}

/** Bot replies go through the same guarded send path as agent replies. */
async function deliver({ tenantId, conversationId, text }) {
  try {
    return await sendText({ tenantId, conversationId, text, byBot: true });
  } catch (err) {
    if (err instanceof SendError) return null;
    throw err;
  }
}