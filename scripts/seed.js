import { pool } from '../src/lib/db.js';
import { encrypt } from '../src/lib/crypto.js';

// Onboards one client. In the agency model this is your checklist,
// run once per tenant with values from their Meta Business account.
const [name, slug, phoneNumberId, displayNumber, token] = process.argv.slice(2);

if (!name || !slug || !phoneNumberId || !displayNumber || !token) {
  console.error(
    'usage: npm run seed -- "Client Name" client-slug <phone_number_id> +919xxxxxxxxx <access_token>'
  );
  process.exit(1);
}

const client = await pool.connect();
try {
  await client.query('BEGIN');
  const { rows: [tenant] } = await client.query(
    `INSERT INTO tenants (name, slug) VALUES ($1, $2)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING *`,
    [name, slug]
  );
  const { rows: [channel] } = await client.query(
    `INSERT INTO channels (tenant_id, phone_number_id, display_number, access_token_enc)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (phone_number_id) DO UPDATE
       SET access_token_enc = EXCLUDED.access_token_enc
     RETURNING *`,
    [tenant.id, phoneNumberId, displayNumber, encrypt(token)]
  );
  await client.query('COMMIT');
  console.log(`tenant ${tenant.slug} (${tenant.id})`);
  console.log(`channel ${channel.display_number} (${channel.id})`);
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release();
  await pool.end();
}