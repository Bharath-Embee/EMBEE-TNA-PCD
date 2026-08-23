// Shared storage API for the TNA system — backed by your existing Neon Postgres
// database instead of a separate KV store.
//
// GET  /api/data?key=xxx                        -> { value: "...", rev: 3 }
// POST /api/data  { key, value, expectedRev }    -> { ok: true, rev: 4 }
//                                                 -> 409 { error: 'conflict', rev, value } if expectedRev is stale
//
// Uses a single simple table (key/value/rev) inside your Neon database, so every
// device that opens this same deployed URL reads and writes the SAME data — this is
// what actually makes the system shared across your team, unlike each browser's own
// local storage. The table is created automatically the first time this runs.
//
// `rev` is a monotonically increasing revision counter per key, used for optimistic
// concurrency control: when two people save around the same time, the second save
// used to silently overwrite the first person's change (last write wins on the whole
// blob, since this is a single JSON document, not per-record updates). Passing the
// `rev` you last read as `expectedRev` on a save turns that into a compare-and-swap —
// if someone else's save landed first, this one is refused (409) instead of quietly
// clobbering theirs. Passing no `expectedRev` at all falls back to the old
// unconditional overwrite, so an older cached client (or the "reset and start fresh"
// flow, which is explicitly meant to force-overwrite) keeps working.
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
  // Additive, idempotent — safe to run on every cold start, and upgrades an
  // existing production table in place with no downtime and no data loss.
  await sql`ALTER TABLE tna_kv ADD COLUMN IF NOT EXISTS rev INTEGER NOT NULL DEFAULT 0`;
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

  // Parsed via the WHATWG URL API rather than the request's auto-populated `.query`
  // (which Vercel's Node runtime derives internally using the legacy, deprecated
  // `url.parse()` — DEP0169). This sidesteps that entirely instead of just moving it.
  const key = req.method === 'GET'
    ? new URL(req.url, 'http://localhost').searchParams.get('key')
    : (req.body && req.body.key);
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
      const rows = await sql`SELECT value, rev FROM tna_kv WHERE key = ${storageKey}`;
      return res.status(200).json({ value: rows[0] ? rows[0].value : null, rev: rows[0] ? rows[0].rev : 0 });
    }

    if (req.method === 'POST') {
      const value = req.body && req.body.value;
      const expectedRev = req.body ? req.body.expectedRev : undefined;
      if (typeof value !== 'string') {
        return res.status(400).json({ error: 'Missing value' });
      }

      if (expectedRev === undefined || expectedRev === null) {
        // No revision supplied — unconditional overwrite (older cached client, or an
        // explicit force-write like "reset and start fresh").
        const rows = await sql`
          INSERT INTO tna_kv (key, value, rev) VALUES (${storageKey}, ${value}, 1)
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, rev = tna_kv.rev + 1
          RETURNING rev
        `;
        return res.status(200).json({ ok: true, rev: rows[0].rev });
      }

      // Compare-and-swap: for a brand-new key the INSERT branch always runs (nothing
      // to conflict with yet). For an existing key, the UPDATE only fires if the
      // stored rev still matches what this client last read — if someone else's save
      // landed in between, the WHERE clause fails, nothing is touched, and RETURNING
      // comes back empty, which is exactly the signal used below to report a conflict
      // instead of silently overwriting their change.
      const rows = await sql`
        INSERT INTO tna_kv (key, value, rev) VALUES (${storageKey}, ${value}, 1)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, rev = tna_kv.rev + 1
        WHERE tna_kv.rev = ${expectedRev}
        RETURNING rev
      `;
      if (rows.length === 0) {
        const current = await sql`SELECT value, rev FROM tna_kv WHERE key = ${storageKey}`;
        return res.status(409).json({ error: 'conflict', value: current[0] ? current[0].value : null, rev: current[0] ? current[0].rev : 0 });
      }
      return res.status(200).json({ ok: true, rev: rows[0].rev });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('TNA backend storage error:', err);
    return res.status(500).json({ error: 'Storage error' });
  }
}
