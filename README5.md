 # Phase 4 — The guarded send path

## Files

NEW:
    src/lib/send.js            the only place allowed to send
    src/workers/outbound.js    delivery worker + rate limiting
    src/repos/templates.js     template mirror + Meta sync
    scripts/set-waba.js        backfill the WABA id
    db/003_waba_id.sql

REPLACE:
    src/routes/api.js          send + template endpoints, assign fix
    src/workers/index.js       registers the outbound worker
    src/workers/inbound.js     strips `raw` from realtime frames
    package.json

## Setup

    npm run migrate
    node scripts/set-waba.js 1219673404562015 906595165832128

Restart `npm run dev` and `npm run worker`.

## Send a message

    curl -s -X POST localhost:3001/api/conversations/$CONV/messages \
      -H "Authorization: Bearer $TOKEN" \
      -H 'content-type: application/json' \
      -d '{"text":"Hello from the platform"}'

Returns 202 with the message row at status `queued`. The worker delivers
it, flips it to `sent`, and Meta's status webhooks carry it through
`delivered` and `read`.

## The window rule

Inside the 24h window: free text works.
Outside it: 422 `window_closed`. Send a template instead:

    -d '{"template":{"name":"hello_world","language":"en_US"}}'

Sync templates from Meta first:

    curl -s -X POST localhost:3001/api/templates/sync -H "Authorization: Bearer $TOKEN"
    curl -s localhost:3001/api/templates -H "Authorization: Bearer $TOKEN"

## Media

    -d '{"media":{"type":"image","link":"https://example.com/x.jpg","caption":"hi"}}'

The link must be publicly reachable — Meta fetches it server-side.

## Design notes

- The message row is written BEFORE the send, at status `queued`, so the
  agent sees it in the thread immediately. Delivery is asynchronous.
- Permanent failures (bad template, invalid number) are not retried;
  only 429s and 5xx are.
- Rate limiting is a per-channel token bucket in Redis, default 20/sec,
  overridable per channel via `channels.send_rate_per_second`.
- Outbound never extends the 24h window. Only inbound does.

## Fixed from Phase 3

- Assign now returns the row after the bot pause, not before.
- Realtime frames no longer carry the full raw Meta payload.
- Replying marks the thread read.