import { resolveSession } from '../lib/auth.js';
import { events } from '../lib/events.js';

/**
 * One WebSocket per open inbox tab. Sockets are grouped by tenant so a
 * message for one client never fans out to another's dashboard.
 */
const tenantSockets = new Map(); // tenantId -> Set<socket>

function add(tenantId, socket) {
  if (!tenantSockets.has(tenantId)) tenantSockets.set(tenantId, new Set());
  tenantSockets.get(tenantId).add(socket);
}

function remove(tenantId, socket) {
  const set = tenantSockets.get(tenantId);
  if (!set) return;
  set.delete(socket);
  if (set.size === 0) tenantSockets.delete(tenantId);
}

function broadcast(tenantId, type, payload) {
  const set = tenantSockets.get(tenantId);
  if (!set) return;
  const frame = JSON.stringify({ type, payload });
  for (const socket of set) {
    if (socket.readyState === 1) socket.send(frame);
  }
}

/** Wire the Redis-backed bus into the socket fan-out. Call once at boot. */
export function bindRealtime() {
  events.on('message.received', (p) =>
    broadcast(p.tenantId, 'message.received', p)
  );
  events.on('message.status', (p) => broadcast(p.tenantId, 'message.status', p));
  events.on('conversation.updated', (p) =>
    broadcast(p.tenantId, 'conversation.updated', p)
  );
}

export async function wsRoutes(app) {
  app.get('/ws', { websocket: true }, async (socket, req) => {
    // Browsers cannot set headers on a WebSocket, so the token comes as a
    // query param. It is a session token, not a password, and the
    // connection is wss in production.
    req.log.info({ query: req.query, url: req.url }, 'ws connect attempt');
    const token = req.query?.token ?? new URL(req.url, 'http://x').searchParams.get('token');
    const auth = await resolveSession(token);

    if (!auth) {
      socket.send(JSON.stringify({ type: 'error', payload: { error: 'unauthorized' } }));
      socket.close(4401, 'unauthorized');
      return;
    }

    add(auth.tenant_id, socket);
    socket.send(
      JSON.stringify({ type: 'ready', payload: { agentId: auth.agent_id } })
    );

    // Heartbeat: drop sockets that stop responding rather than leaking them.
    socket.isAlive = true;
    socket.on('pong', () => {
      socket.isAlive = true;
    });

    socket.on('close', () => remove(auth.tenant_id, socket));
    socket.on('error', () => remove(auth.tenant_id, socket));
  });

  const interval = setInterval(() => {
    for (const set of tenantSockets.values()) {
      for (const socket of set) {
        if (socket.isAlive === false) {
          socket.terminate();
          continue;
        }
        socket.isAlive = false;
        socket.ping();
      }
    }
  }, 30_000);

  app.addHook('onClose', async () => clearInterval(interval));
}