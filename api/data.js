// Shared storage API for the TNA system — backed by your existing Neon Postgres
// database instead of a separate KV store.
//
// GET  /api/data?key=xxx        -> { value: "..." }
// POST /api/data  { key, value } -> { ok: true }
//
// Uses a single simple table (key/value) inside your Neon database, so every device
// that opens this same deployed URL reads and writes the SAME data — this is what
// actually makes the system shared across your team, unlike each browser's own
// local storage. The table is created automatically the first time this runs.
//
// Optional lightweight protection: set an environment variable called
// TNA_API_SECRET in your Vercel project settings, and every request must then
// include a matching "x-api-key" header. This is a speed bump against randoms
// poking at your API, not real security — the key still lives in this page's own
// JavaScript, so anyone determined enough could find it via view-source. Treat this
// as "keep casual visitors and bots out," not as protecting truly sensitive data.

import { neon } from '@neondatabase/serverless';

// Vercel's "Connect to a Database" dialog lets you pick a custom variable name
// prefix, so the exact env var name it creates can vary. Rather than depend on you
// choosing one specific value in that dialog, check every name Vercel/Neon commonly
// use — whichever one actually got created, this will find it.
const connectionString =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.STORAGE_URL ||
  process.env.STORAGE_DATABASE_URL ||
  process.env.DATABASE_URL_UNPOOLED ||
  process.env.STORAGE_DATABASE_URL_UNPOOLED ||
  process.env.POSTGRES_PRISMA_URL;
const sql = connectionString ? neon(connectionString) : null;

let tableReady = false;
async function ensureTable() {
  if (tableReady) return;
  await sql`CREATE TABLE IF NOT EXISTS tna_kv (key TEXT PRIMARY KEY, value TEXT)`;
  tableReady = true;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!sql) {
    const seen = Object.keys(process.env).filter(k => /URL/i.test(k)).join(', ') || '(none found)';
    return res.status(500).json({ error: 'No database connection string found. Env vars containing "URL": ' + seen });
  }

  const secret = process.env.TNA_API_SECRET;
  if (secret && req.headers['x-api-key'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const key = (req.method === 'GET' ? req.query.key : req.body && req.body.key);
  if (!key || typeof key !== 'string') {
    return res.status(400).json({ error: 'Missing key' });
  }

  // A harmless connectivity check the front-end uses on load to detect whether a
  // real backend is available at all, without needing any real data to exist yet.
  if (key === '__ping__') {
    try { await ensureTable(); } catch (e) { return res.status(500).json({ error: 'DB not reachable' }); }
    return res.status(200).json({ value: null });
  }

  const storageKey = 'tna:' + key;

  try {
    await ensureTable();

    if (req.method === 'GET') {
      const rows = await sql`SELECT value FROM tna_kv WHERE key = ${storageKey}`;
      return res.status(200).json({ value: rows[0] ? rows[0].value : null });
    }

    if (req.method === 'POST') {
      const value = req.body && req.body.value;
      if (typeof value !== 'string') {
        return res.status(400).json({ error: 'Missing value' });
      }
      await sql`
        INSERT INTO tna_kv (key, value) VALUES (${storageKey}, ${value})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
      `;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('TNA backend storage error:', err);
    return res.status(500).json({ error: 'Storage error' });
  }
}
