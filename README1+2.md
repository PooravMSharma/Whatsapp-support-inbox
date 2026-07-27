# WhatsApp Automation Platform

Multi-tenant support-inbox platform on the WhatsApp Cloud API.
Agency model: you onboard each client manually, they get an inbox.

## Phase 1 + 2 (this drop)

- Postgres schema with row-level tenant isolation
- Channel adapter abstraction + Cloud API implementation
- Webhook ingress: signature verification, dedupe, queue, fast ACK
- Inbound worker: messages and delivery statuses become rows
- 24h service window tracking
- Per-tenant conversation usage metering

## Setup

    cp .env.example .env
    openssl rand -hex 32     # -> ENCRYPTION_KEY
    npm install
    npm run migrate

Onboard a client:

    npm run seed -- "Acme Corp" acme 123456789012345 +919876543210 EAAG...

Run:

    npm run dev       # API
    npm run worker    # queue worker (separate process)

## Pointing Meta at it

1. Expose port 3000 publicly (ngrok in dev).
2. Meta App Dashboard -> WhatsApp -> Configuration -> Webhook
   - Callback URL: `https://<host>/webhooks/meta`
   - Verify token: whatever you put in `META_VERIFY_TOKEN`
3. Subscribe to the `messages` field.
4. Message the test number. A row should appear in `messages`.

## Layout

    db/001_init.sql        schema
    src/channels/          adapter interface + cloud api impl
    src/routes/webhook.js  ingress (fast, paranoid)
    src/workers/inbound.js message + status processing
    src/repos/             all tenant-scoped queries
    src/lib/               db, queue, crypto, event bus

## Design rules that matter later

- Nothing above `src/channels/` knows Cloud API exists.
- Every query takes an explicit `tenantId`.
- Status webhooks arrive out of order; status never downgrades.
- `provider_message_id` unique index is the idempotency guarantee.
- Webhook handler does no network I/O. Ever.

## Next (Phase 3)

Inbox API + realtime. Then the guarded send path, then the bot.
