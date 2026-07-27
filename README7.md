# Phase 6 — Automation

Keyword auto-replies, business hours, and escalation to a human.

## Files

NEW:
    db/004_bot.sql
    src/repos/bot.js
    src/lib/bot.js

REPLACE:
    src/routes/api.js        bot endpoints
    src/workers/inbound.js   runs the bot after storing a message
    src/workers/outbound.js  records when a HUMAN replied
    src/lib/send.js          passes byBot through to the job

## Setup

    npm run migrate

Restart `npm run dev` and `npm run worker`.

Automation starts **disabled**. Turn it on deliberately:

    curl -s -X PUT localhost:3001/api/bot/settings \
      -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
      -d '{"enabled":true,"offHoursReply":"Thanks for writing. We reply between 9am and 7pm."}'

## Add rules

    # greeting
    curl -s -X POST localhost:3001/api/bot/rules \
      -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
      -d '{"name":"Greeting","matchType":"greeting","priority":10,
           "replyText":"Hi! How can we help?"}'

    # keyword
    curl -s -X POST localhost:3001/api/bot/rules \
      -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
      -d '{"name":"Opening hours","matchType":"keyword","priority":20,
           "keywords":["hours","timing","open","closed"],
           "replyText":"We are open 9am to 7pm, Monday to Saturday."}'

    # escalation
    curl -s -X POST localhost:3001/api/bot/rules \
      -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
      -d '{"name":"Ask for a person","matchType":"keyword","priority":30,
           "keywords":["agent","human","person","complaint"],
           "action":"escalate","pauseMinutes":120,
           "replyText":"Putting you through to someone now."}'

    # fallback
    curl -s -X POST localhost:3001/api/bot/rules \
      -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
      -d '{"name":"Catch-all","matchType":"fallback","priority":99,
           "replyText":"Thanks — someone will reply shortly."}'

## Test without sending anything

    curl -s -X POST localhost:3001/api/bot/test \
      -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
      -d '{"text":"what time do you open"}'

Returns which rule matched and what would be sent. Nothing is delivered.

## Endpoints

    GET    /api/bot/settings
    PUT    /api/bot/settings     { enabled, humanGraceMinutes,
                                   maxRepliesPerHour, businessHours,
                                   offHoursReply }
    GET    /api/bot/rules
    POST   /api/bot/rules
    PUT    /api/bot/rules/:id
    DELETE /api/bot/rules/:id
    GET    /api/bot/stats        last 7 days
    POST   /api/bot/test         dry run

## How a rule is chosen

Rules are evaluated by `priority` ascending, first match wins:

    greeting  -> the contact's first ever message
    exact     -> the whole message equals a phrase
    keyword   -> any listed word appears, matched on WORD BOUNDARIES
                 ("hi" does not match "this")
    fallback  -> nothing else matched

## When the bot stays quiet

Most of this module is about NOT replying. It skips when:

    the tenant has automation disabled
    the message is not text
    an agent took the conversation (bot_paused_until)
    a human replied within the grace period (default 60 min)
    the 24-hour window is closed
    it already replied max_replies_per_hour times (default 6)
    it is outside business hours and no off-hours message is set
    no rule matched and there is no fallback

Every skip is logged with its reason in `bot_replies`, so you can see why
the bot said nothing.

## Safety properties

- The bot runs AFTER the message is stored and broadcast, so a bot failure
  can never lose an inbound message.
- Bot replies go through the same guarded send path as agent replies, so
  the window rule applies to them too.
- A bot reply does NOT start the human grace period; only an agent's does.
- Escalation pauses the bot and sets the conversation to pending, so it
  surfaces in the inbox rather than being silently handled.