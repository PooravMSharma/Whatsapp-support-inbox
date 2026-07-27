# Phase 3 — Inbox API + Realtime

## Install new deps

    npm install

Adds `@fastify/websocket` and `@fastify/cors`.

## Migrate

    npm run migrate      # runs db/002_sessions.sql

## Create your first agent

    npm run create-agent -- test-client you@example.com "Your Name" yourpassword

## Restart both processes

    npm run dev
    npm run worker

## Endpoints

Auth:

    POST /api/auth/login    { email, password, tenant }  -> { token, agent }
    POST /api/auth/logout

Everything below needs `Authorization: Bearer <token>`:

    GET  /api/me
    GET  /api/agents
    GET  /api/counts
    GET  /api/conversations?filter=all|mine|unassigned|resolved&cursor=
    GET  /api/conversations/:id
    GET  /api/conversations/:id/messages?before=
    POST /api/conversations/:id/assign    { agentId }   (omit = self, null = unassign)
    POST /api/conversations/:id/status    { status }
    POST /api/conversations/:id/read
    POST /api/conversations/:id/bot       { pauseMinutes }

Realtime:

    ws://localhost:3001/ws?token=<session token>

Frames: `ready`, `message.received`, `message.status`, `conversation.updated`.

## Quick test

    TOKEN=$(curl -s localhost:3001/api/auth/login \
      -H 'content-type: application/json' \
      -d '{"email":"you@example.com","password":"yourpassword","tenant":"test-client"}' \
      | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')

    curl -s localhost:3001/api/conversations -H "Authorization: Bearer $TOKEN"
    curl -s localhost:3001/api/counts        -H "Authorization: Bearer $TOKEN"

Then send a WhatsApp message and re-run — `unread` should increment.

## What changed from Phase 2

- `config.js` validates lazily per section, so `npm run migrate` no longer
  needs Meta credentials.
- Request logs strip query strings (verify tokens and session tokens were
  landing in log output).
- `events.js` is now Redis pub/sub, because the worker writes the message
  but the API holds the WebSocket.
- Sessions are stored as SHA-256 hashes; passwords use scrypt.
- Assigning a conversation pauses the bot for 60 minutes automatically.

## Next (Phase 4)

The guarded send path: window check -> template check -> rate limit ->
queue -> adapter -> status webhook. Then the frontend.