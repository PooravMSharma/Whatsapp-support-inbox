import { pool } from '../src/lib/db.js';
import { hashPassword } from '../src/lib/crypto.js';

const [tenantSlug, email, name, password, role = 'owner'] = process.argv.slice(2);

if (!tenantSlug || !email || !name || !password) {
  console.error(
    'usage: npm run create-agent -- <tenant-slug> <email> "<Full Name>" <password> [role]'
  );
  process.exit(1);
}

const { rows: [tenant] } = await pool.query(
  'SELECT id FROM tenants WHERE slug = $1',
  [tenantSlug]
);
if (!tenant) {
  console.error(`No tenant with slug "${tenantSlug}"`);
  process.exit(1);
}

const { rows: [agent] } = await pool.query(
  `INSERT INTO agents (tenant_id, email, name, password_hash, role)
   VALUES ($1, $2, $3, $4, $5)
   ON CONFLICT (tenant_id, email) DO UPDATE
     SET password_hash = EXCLUDED.password_hash,
         name = EXCLUDED.name,
         role = EXCLUDED.role
   RETURNING id, email, name, role`,
  [tenant.id, email, name, hashPassword(password), role]
);

console.log(`agent ${agent.email} (${agent.role}) — ${agent.id}`);
await pool.end();