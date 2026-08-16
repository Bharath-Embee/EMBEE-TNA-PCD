// Registers (or re-registers) a browser/device's FCM push token against a user.
// Called from the client once the user grants notification permission.
//
// POST /api/register-token  { userId, token, deviceInfo } -> { ok: true }
//
// A user can have multiple tokens (desktop + mobile + multiple browsers) — this
// table supports that directly (one row per token, all pointing at the same
// user_id). Re-registering the same token (e.g. on every login) just refreshes
// last_used_at rather than creating a duplicate row, via ON CONFLICT on the
// token's own UNIQUE constraint.

import { neon } from '@neondatabase/serverless';

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
  await sql`CREATE TABLE IF NOT EXISTS notification_tokens (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    device_info TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    last_used_at TIMESTAMPTZ DEFAULT now(),
    active BOOLEAN DEFAULT true
  )`;
  tableReady = true;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!sql) return res.status(500).json({ error: 'Database not connected' });

  const { userId, token, deviceInfo } = req.body || {};
  if (!userId || !token) {
    return res.status(400).json({ error: 'Missing userId or token' });
  }

  try {
    await ensureTable();
    await sql`
      INSERT INTO notification_tokens (user_id, token, device_info, active, last_used_at)
      VALUES (${userId}, ${token}, ${deviceInfo || ''}, true, now())
      ON CONFLICT (token) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        device_info = EXCLUDED.device_info,
        active = true,
        last_used_at = now()
    `;
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('register-token error:', err);
    return res.status(500).json({ error: 'Failed to register token' });
  }
}
