import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import { config } from './config.js';
import { pool } from './lib/db.js';
import { webhookRoutes } from './routes/webhook.js';
import { authRoutes, inboxRoutes } from './routes/api.js';
import { wsRoutes, bindRealtime } from './routes/ws.js';
import { appRoutes } from './routes/app.js';
import { initSubscriber, closeRealtime } from './lib/events.js';

const app = Fastify({
  logger: {
    level: config.env === 'production' ? 'info' : 'debug',
    // The webhook handshake carries the verify token in the query string
    // and agents pass session tokens the same way on /ws. Neither belongs
    // in a log file, so log the path only.
    serializers: {
      req(req) {
        return {
          method: req.method,
          url: req.url.split('?')[0],
          remoteAddress: req.ip,
        };
      },
    },
  },
  trustProxy: true,
});

// Raw body is needed to verify Meta's HMAC signature.
app.addContentTypeParser(
  'application/json',
  { parseAs: 'buffer' },
  (req, body, done) => {
    req.rawBody = body;
    try {
      done(null, body.length ? JSON.parse(body.toString('utf8')) : {});
    } catch (err) {
      err.statusCode = 400;
      done(err, undefined);
    }
  }
);

await app.register(cors, { origin: true, credentials: true });
await app.register(websocket);

app.get('/health', async () => {
  await pool.query('SELECT 1');
  return { ok: true, ts: new Date().toISOString() };
});

await app.register(webhookRoutes);
await app.register(authRoutes);
await app.register(inboxRoutes);
await app.register(wsRoutes);
await app.register(appRoutes);

await initSubscriber(app.log);
bindRealtime();

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

const shutdown = async (signal) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await closeRealtime();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));