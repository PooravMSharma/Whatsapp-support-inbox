# WhatsApp Support Inbox

A multi-tenant support desk built on the WhatsApp Cloud API. Customers
message a business on WhatsApp; agents see those conversations live in a
browser and reply from there. A rules engine answers common questions
automatically and hands the rest to a human.

One deployment serves many client businesses, each isolated from the others.

---

## Why this exists

WhatsApp is designed for one person with one phone. A business hits walls
immediately: only one device can hold the number, two agents can't see the
same conversation, nothing is searchable, and nothing can be automated.

This turns WhatsApp into a channel a team can actually work.

---

## The rule that shapes everything

WhatsApp does not let a business message people freely. After a customer
writes, the business has a **24-hour window** to reply with anything.
Once it closes, only templates Meta has pre-approved may be sent.

Every part of the system reflects this:

- Conversations track when their window expires
- One send path enforces it; nothing bypasses that path
- The console draws the remaining window as a bar that drains, turns amber
  near the end, and goes hatched when shut
- When shut, the reply box is replaced by a template picker

The constraint isn't documented in a tooltip. It's built into what an agent
can physically do.

---

## Stack

Node.js · Fastify · PostgreSQL · Redis · BullMQ · WebSockets
Frontend is a single HTML file with no build step.

Two processes: an **API server** and a **queue worker**, sharing a database
and a Redis instance.

---

## How a message travels

**Inbound**

    customer's WhatsApp
      → Meta
      → POST to one webhook URL
      → verify Meta's HMAC signature
      → deduplicate
      → store raw event, queue a job, return 200 immediately
      → worker: upsert contact, conversation, message
      → reopen the 24-hour window
      → publish to Redis
      → API pushes down the WebSocket
      → appears in the agent's browser
      → bot evaluates whether to reply

The webhook handler makes no network calls and returns in milliseconds.
Meta retries aggressively and punishes slow endpoints, so all real work is
deferred to the worker.

**Outbound**

    agent (or bot) sends
      → check the 24-hour window
      → check template approval if outside it
      → write the message row at status "queued" — visible instantly
      → queue the job
      → worker: rate-limit check, call the Cloud API
      → flip to "sent"
      → Meta's status webhooks carry it to "delivered" and "read"

The row is written *before* the send, so the interface never waits on Meta.

---

## Design decisions

**One webhook URL for every client.** Meta posts all events to a single
endpoint. The payload carries a `phone_number_id`, which maps to a channel,
which maps to a tenant. The handler is a dispatcher.

**A channel adapter interface.** Nothing above `src/channels/` knows the
Cloud API exists. Supporting another provider means writing one file.

**Row-level tenant isolation.** Every table carries `tenant_id`, and every
repository function takes one explicitly. Hard to leak by accident.

**Idempotency by constraint.** Meta redelivers webhooks. A unique index on
the provider's message id makes duplicates impossible, not just unlikely.

**Statuses never downgrade.** Delivery receipts arrive out of order; a
`sent` arriving after `read` is ignored.

**Permanent vs retryable failures.** A rate limit retries with backoff. A
bad template name fails once, records why, and stops.

**The bot mostly decides not to speak.** It stays silent when an agent has
taken over, when a human replied recently, when the window is closed, when
it has already replied too often, and outside business hours. Every skip is
logged with its reason.

---

## Data model

    tenants              client businesses
    channels             a WhatsApp number, its credentials, its tenant
    agents               people who work the inbox
    sessions             agent logins, tokens stored hashed
    contacts             end customers
    conversations        one thread per contact per channel
    messages             everything sent and received
    templates            mirrored from Meta, with approval status
    webhook_events       raw inbound events, for dedupe and replay
    usage_conversations  per-tenant billing meter
    bot_settings         automation switches per tenant
    bot_rules            keyword rules, evaluated by priority
    bot_replies          what the bot did, and why it didn't

`conversations` is the heart of it — window expiry, assignment, unread
count, bot pause. Almost every feature reads it.

---

## Security

- Client access tokens encrypted at rest (AES-256-GCM)
- Agent passwords hashed with scrypt
- Session tokens stored as SHA-256 hashes, so a database leak doesn't hand
  over live logins
- Every webhook's HMAC signature verified before it's trusted
- Query strings stripped from request logs

---

## Setup

**Requirements:** Node 20+, PostgreSQL, Redis.

    cp .env.example .env
    openssl rand -hex 32        # → ENCRYPTION_KEY

Fill in from the Meta App Dashboard:

    META_APP_SECRET     App settings → Basic → App secret
    META_VERIFY_TOKEN   any random string you invent

Then:

    createdb wa_platform
    npm install
    npm run migrate

**Onboard a client** — phone number id and access token come from
WhatsApp → API Setup:

    npm run seed -- "Client Name" client-slug <phone_number_id> +91xxxxxxxxxx "<token>"
    node scripts/set-waba.js <phone_number_id> <waba_id>

**Create an agent:**

    npm run create-agent -- client-slug agent@example.com "Agent Name" password

**Run:**

    npm run dev       # API
    npm run worker    # queue worker, separate process

Open **http://localhost:3001/app**

---

## Connecting Meta

1. Expose the port publicly (`ngrok http 127.0.0.1:3001` in development)
2. Meta dashboard → WhatsApp → Configuration → Webhook
   - Callback URL: `https://<host>/webhooks/meta`
   - Verify token: your `META_VERIFY_TOKEN`
3. Subscribe to the **messages** field
4. Subscribe your app to the WhatsApp Business Account:

       curl -X POST "https://graph.facebook.com/v20.0/<waba_id>/subscribed_apps" \
         -H "Authorization: Bearer <token>"

Step 4 is separate from step 3 and invisible in the dashboard. Skipping it
is the most common reason everything looks configured and no webhooks
arrive.

Use a **System User token** with `whatsapp_business_messaging` and
`whatsapp_business_management`, set to never expire. Temporary tokens last
24 hours and take the webhook subscription with them when they die.

---

## API

**Auth**

    POST /api/auth/login      { email, password, tenant } → { token, agent }
    POST /api/auth/logout

Everything below needs `Authorization: Bearer <token>`.

**Inbox**

    GET  /api/me
    GET  /api/agents
    GET  /api/counts
    GET  /api/conversations?filter=all|mine|unassigned|resolved
    GET  /api/conversations/:id
    GET  /api/conversations/:id/messages
    POST /api/conversations/:id/assign     { agentId }
    POST /api/conversations/:id/status     { status }
    POST /api/conversations/:id/read
    POST /api/conversations/:id/bot        { pauseMinutes }

**Sending**

    POST /api/conversations/:id/messages
      { "text": "..." }
      { "template": { "name": "...", "language": "en_US", "variables": {} } }
      { "media": { "type": "image", "link": "https://...", "caption": "..." } }

Returns 202 with the queued row. Outside the window, free text returns 422
`window_closed`.

**Templates**

    GET  /api/templates?approved=true
    POST /api/templates/sync

**Automation**

    GET    /api/bot/settings
    PUT    /api/bot/settings
    GET    /api/bot/rules
    POST   /api/bot/rules
    PUT    /api/bot/rules/:id
    DELETE /api/bot/rules/:id
    GET    /api/bot/stats
    POST   /api/bot/test          dry run — matches without sending

**Realtime**

    ws://host/ws?token=<session token>

Frames: `ready`, `message.received`, `message.status`,
`conversation.updated`.

---

## Automation

Rules are evaluated by priority ascending; first match wins.

    greeting   the contact's first ever message
    exact      the whole message equals a phrase
    keyword    any listed word appears, matched on word boundaries
               ("hi" does not match "this")
    fallback   nothing else matched

Actions are `reply` or `escalate`. Escalating sets the conversation to
pending, optionally assigns an agent, and pauses the bot.

    curl -X POST localhost:3001/api/bot/rules \
      -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
      -d '{"name":"Opening hours","matchType":"keyword","priority":20,
           "keywords":["hours","timing","open"],
           "replyText":"We are open 9am to 7pm, Monday to Saturday."}'

Automation is **off by default**. Enable it per tenant via
`PUT /api/bot/settings`.

---

## Layout

    db/                  migrations, applied in filename order
    public/index.html    the entire console
    scripts/             migrate, seed, create-agent, set-waba
    src/channels/        adapter interface + Cloud API implementation
    src/lib/             db, queue, crypto, auth, events, send, bot
    src/repos/           all tenant-scoped queries
    src/routes/          webhook, api, ws, app
    src/workers/         inbound and outbound processing

---

## Build order

Deliberately: **receiving before sending, inbox before bot.**

1. Schema and skeleton
2. Webhook ingress — prove a real message reaches the database
3. Inbox API, agent auth, live updates
4. The guarded send path
5. The browser console
6. Automation

The bot came last on purpose. A working shared inbox is already useful. A
clever bot with nowhere to read the conversation is a demo.

---

## Known gaps

- A failed bot reply doesn't surface in the inbox; an agent sees a question
  with no answer and no sign anything was attempted
- Media is send-only; inbound attachments are stored by id but not fetched
- No rules UI — automation is configured through the API
- No deployment config

## Troubleshooting

When messages stop arriving, work backwards. The failure is always visible
at exactly one of these four points:

1. The tunnel's request list — did a POST arrive, and with what status?
2. `webhook_events` — was it stored? Is `processed_at` null? Any error?
3. `messages` — did the worker write it?
4. The worker terminal — what did it throw?

Most common causes, in order: the WABA subscription silently dropped
(usually after a token change), the access token expired, or a process
isn't running.