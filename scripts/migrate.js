import fs from 'node:fs';
import path from 'node:path';
import { pool } from '../src/lib/db.js';

const dir = path.join(process.cwd(), 'db');

await pool.query(`
  CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    run_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

const { rows } = await pool.query('SELECT name FROM _migrations');
const done = new Set(rows.map((r) => r.name));
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

for (const file of files) {
  if (done.has(file)) {
    console.log(`skip  ${file}`);
    continue;
  }
  const sql = fs.readFileSync(path.join(dir, file), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
    await client.query('COMMIT');
    console.log(`ran   ${file}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`FAIL  ${file}: ${err.message}`);
    process.exit(1);
  } finally {
    client.release();
  }
}

await pool.end();
console.log('migrations complete');