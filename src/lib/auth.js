import { one, query } from '../lib/db.js';
import {
  verifyPassword,
  newSessionToken,
  hashToken,
} from '../lib/crypto.js';
import { config } from '../config.js';

export async function login({ email, password, tenantSlug }) {
  const agent = await one(
    `SELECT a.*, t.slug AS tenant_slug
       FROM agents a
       JOIN tenants t ON t.id = a.tenant_id
      WHERE lower(a.email) = lower($1)
        AND t.slug = $2
        AND a.is_active = true`,
    [email, tenantSlug]
  );

  // Same generic failure whether the agent is missing or the password is
  // wrong, so this endpoint cannot be used to enumerate accounts.
  if (!agent || !verifyPassword(password, agent.password_hash)) return null;

  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + config.sessionDays * 86_400_000);

  await query(
    `INSERT INTO sessions (agent_id, tenant_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [agent.id, agent.tenant_id, hashToken(token), expiresAt]
  );

  return {
    token,
    expiresAt,
    agent: {
      id: agent.id,
      name: agent.name,
      email: agent.email,
      role: agent.role,
      tenantId: agent.tenant_id,
      tenantSlug: agent.tenant_slug,
    },
  };
}

export async function resolveSession(token) {
  if (!token) return null;

  const row = await one(
    `SELECT s.id AS session_id, s.tenant_id, a.id AS agent_id,
            a.name, a.email, a.role
       FROM sessions s
       JOIN agents a ON a.id = s.agent_id
      WHERE s.token_hash = $1
        AND s.expires_at > now()
        AND a.is_active = true`,
    [hashToken(token)]
  );
  if (!row) return null;

  // Fire and forget; a failed heartbeat should not fail the request.
  query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [row.session_id])
    .catch(() => {});

  return row;
}

export async function logout(token) {
  if (!token) return;
  await query(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)]);
}

export function bearerFrom(req) {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return null;
}

/**
 * Fastify preHandler. Attaches req.auth = { tenant_id, agent_id, role }.
 * Every route below /api uses this, which is what makes tenant scoping
 * automatic rather than something each handler must remember.
 */
export async function requireAuth(req, reply) {
  const auth = await resolveSession(bearerFrom(req));
  if (!auth) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  req.auth = auth;
}