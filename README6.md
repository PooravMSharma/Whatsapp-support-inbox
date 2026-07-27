# Phase 5 — The inbox console

## Files

NEW:
    public/index.html        the whole console, one file
    src/routes/app.js        serves it

REPLACE:
    src/server.js            registers the app route

## Run

Restart `npm run dev`, then open:

    http://localhost:3001/app

Sign in with the agent you created:
workspace `test-client`, your email, your password.

## What it does

- Filters: Open / Mine / Unassigned / Resolved, with live counts
- Conversation list with unread badges and assignee
- Thread view, grouped by day, with delivery status on outbound messages
- Reply box that sends on Enter
- Assign to me, Resolve / Reopen
- Live updates over WebSocket — a green dot by the title means connected;
  it greys out and reconnects on its own if the socket drops

## The signature: the window meter

Every conversation row carries a thin bar showing how much of the 24-hour
reply window is left. It drains as the window closes, turns amber under
six hours, and goes to a hatched line once shut.

When the window is closed, the reply box is replaced by a template picker
that explains why. The rule that governs everything an agent can do is
drawn rather than described.

The meter redraws every 30 seconds so it moves without a refresh.

## Notes

- Session token is kept in sessionStorage, so closing the tab signs out.
- The composer refetches the conversation whenever an inbound message
  arrives, because a customer replying reopens the window.
- Mobile collapses to a single column; the layout is not a phone-first
  design and agents are assumed to be at a desk.