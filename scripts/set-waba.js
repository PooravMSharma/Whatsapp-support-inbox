import { pool } from '../src/lib/db.js';

// Template sync needs the WhatsApp Business Account id, which the seed
// script did not capture. One-off backfill.
const [phoneNumberId, wabaId] = process.argv.slice(2);

if (!phoneNumberId || !wabaId) {
  console.error('usage: node scripts/set-waba.js <phone_number_id> <waba_id>');
  process.exit(1);
}

const { rows } = await pool.query(
  `UPDATE channels SET waba_id = $2, updated_at = now()
    WHERE phone_number_id = $1
    RETURNING display_number, waba_id`,
  [phoneNumberId, wabaId]
);

console.log(rows[0] ? `updated ${rows[0].display_number} -> ${rows[0].waba_id}` : 'no channel matched');
await pool.end();