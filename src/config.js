import 'dotenv/config';

/**
 * Config is validated lazily, per section.
 *
 * The migration script has no business needing Meta credentials, so
 * accessing config.meta is what triggers validation of Meta vars, not
 * merely importing this file.
 */

function need(key) {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

function lazy(fn) {
  let cached;
  return () => (cached ??= fn());
}

const metaSection = lazy(() => ({
  verifyToken: need('META_VERIFY_TOKEN'),
  appSecret: need('META_APP_SECRET'),
  graphVersion: process.env.META_GRAPH_VERSION || 'v20.0',
  graphBase: 'https://graph.facebook.com',
}));

const cryptoSection = lazy(() => need('ENCRYPTION_KEY'));

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),

  get databaseUrl() {
    return need('DATABASE_URL');
  },
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',

  get meta() {
    return metaSection();
  },
  get encryptionKey() {
    return cryptoSection();
  },

  windowHours: 24,
  sessionDays: 30,
};