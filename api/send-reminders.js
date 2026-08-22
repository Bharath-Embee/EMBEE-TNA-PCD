// Daily reminder scanner — triggered by Vercel Cron (see vercel.json).
// Reads the SAME task data the app already uses (no second data source), finds
// tasks due in 3 days / 1 day / today for their assigned user only, and sends a
// push notification through Firebase Cloud Messaging.
//
// Also sends a daily reminder for OVERDUE open tasks (past their due date and
// not yet resolved) — one per day, every day, until the task is closed out.
//
// Security: only Vercel's own cron trigger can call this — it sends an
// Authorization header matching CRON_SECRET automatically. Nobody else can
// trigger reminder sends by hitting this URL.
//
// Idempotency: notification_log has a UNIQUE constraint on
// (task_id, reminder_type, channel). Before sending, this inserts a row —
// if that fails (already exists), the reminder was already sent/attempted and
// is skipped. This works correctly even if the cron somehow runs twice, because
// the database itself — not memory — enforces the "only once" guarantee.
// For overdue tasks, reminder_type includes today's date (e.g. "overdue_2026-08-19"),
// so each calendar day counts as a distinct reminder and the task keeps getting
// a fresh one every day it remains open and overdue.

import { neon } from '@neondatabase/serverless';
import admin from 'firebase-admin';
import nodemailer from 'nodemailer';

const connectionString =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.STORAGE_URL ||
  process.env.STORAGE_DATABASE_URL ||
  process.env.DATABASE_URL_UNPOOLED ||
  process.env.STORAGE_DATABASE_URL_UNPOOLED ||
  process.env.POSTGRES_PRISMA_URL;
const sql = connectionString ? neon(connectionString) : null;

if (!admin.apps.length && process.env.FIREBASE_PROJECT_ID) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // Vercel env vars sometimes store literal "\n" instead of real newlines —
      // this handles either case safely.
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}

// Mirrors the exact same task-status/date logic already used in index.html
// (RESOLVED_STATUSES, isOpenTask, opDate) — kept in sync deliberately rather
// than trying to share code across a static HTML file and a serverless
// function, which would add more risk than it removes.
const RESOLVED_STATUSES = ['Done', 'Approved', 'Rejected', 'N/A'];
function isOpenTask(t) { return !RESOLVED_STATUSES.includes(t.status); }
function opDate(t) { return t.expectedDate || t.plannedDate; }
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function fmtDate(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
function classifyReminder(task, today) {
  if (!isOpenTask(task)) return null;
  if (!task.assignedTo) return null;
  const due = opDate(task);
  if (!due) return null;
  if (due === today) return 'due';
  if (due === addDays(today, 3)) return '3day';
  if (due === addDays(today, 1)) return '1day';
  // Overdue and still open: tag the reminder with today's date so the
  // idempotency check treats each day as a new reminder — this is what makes
  // overdue tasks nag daily instead of just once.
  if (due < today) return `overdue_${today}`;
  return null;
}
const REMINDER_LABEL = { due: 'due today', '1day': 'due tomorrow', '3day': 'due in 3 days', overdue: 'overdue' };
const REMINDER_SUBJECT = { due: 'due today', '1day': 'due in 1 day', '3day': 'due in 3 days', overdue: 'overdue' };
// reminderType for overdue tasks is dynamic (e.g. "overdue_2026-08-19"), so these
// helpers normalize it back to the plain 'overdue' key before looking up labels/subjects.
function labelFor(t) { return REMINDER_LABEL[t.startsWith('overdue') ? 'overdue' : t]; }
function subjectFor(t) { return REMINDER_SUBJECT[t.startsWith('overdue') ? 'overdue' : t]; }

function buildEmail(user, task, order, reminderType) {
  const due = opDate(task);
  const appUrl = process.env.APP_URL || 'https://embee-tna-pcd.vercel.app';
  const link = `${appUrl}/#order=${encodeURIComponent(order.id)}`;
  const firstName = (user.name || '').split(' ')[0] || 'there';
  const subject = `TNA Task Reminder — ${task.name} ${subjectFor(reminderType)}`;
  const html = `<div style="font-family:sans-serif;max-width:480px;color:#17233A;">
    <h2 style="margin-bottom:4px;">TNA Task Reminder</h2>
    <p>Dear ${firstName},</p>
    <p><strong>Task:</strong> ${task.name}</p>
    <p><strong>Style:</strong> ${order.styleNo || ''} — ${order.item || ''}</p>
    <p><strong>Due Date:</strong> ${fmtDate(due)}</p>
    <p><strong>Reminder:</strong> ${labelFor(reminderType)}</p>
    <p><a href="${link}" style="display:inline-block;background:#17233A;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;">Open Task</a></p>
  </div>`;
  return { subject, html };
}

// Sends via Gmail's SMTP relay, using a Google Workspace account's App Password.
// This was switched from Resend because Resend's free onboarding@resend.dev sender
// can only deliver to the Resend account owner's own inbox — real domain
// verification would need DNS access this project doesn't have. Gmail SMTP has no
// such restriction: any embeegroup.com Workspace account can send to any address
// once 2-Step Verification is on and an App Password is generated (Google Account
// → Security → App Passwords) — no admin/DNS involvement needed.
let gmailTransport = null;
function getGmailTransport() {
  if (!gmailTransport) {
    gmailTransport = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });
  }
  return gmailTransport;
}
async function sendEmail(user, to, cc, task, order, reminderType) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    throw new Error('GMAIL_USER / GMAIL_APP_PASSWORD not set');
  }
  const { subject, html } = buildEmail(user, task, order, reminderType);
  const mail = {
    from: `"TNA Reminders" <${process.env.GMAIL_USER}>`,
    to,
    subject,
    html,
  };
  if (cc && cc.length) mail.cc = cc;
  await getGmailTransport().sendMail(mail);
}

async function ensureTables() {
  await sql`CREATE TABLE IF NOT EXISTS notification_tokens (
    id SERIAL PRIMARY KEY, user_id TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
    device_info TEXT, created_at TIMESTAMPTZ DEFAULT now(),
    last_used_at TIMESTAMPTZ DEFAULT now(), active BOOLEAN DEFAULT true
  )`;
  await sql`CREATE TABLE IF NOT EXISTS notification_log (
    id SERIAL PRIMARY KEY, task_id TEXT NOT NULL, user_id TEXT NOT NULL,
    reminder_type TEXT NOT NULL, channel TEXT NOT NULL, sent_at TIMESTAMPTZ DEFAULT now(),
    status TEXT NOT NULL, error TEXT,
    UNIQUE (task_id, reminder_type, channel)
  )`;
}

export default async function handler(req, res) {
  // Only Vercel's own cron trigger (or someone who knows CRON_SECRET) may call this.
  const auth = req.headers['authorization'];
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Vercel Hobby cron doesn't fire at an exact minute — it can land anywhere within
  // roughly an hour of the scheduled time, which made an "only run at exactly 7am
  // Cairo" gate unreliable (a run landing at 8am Cairo was silently skipped).
  // Every invocation is now allowed to run — safety against duplicate emails comes
  // from the notification_log UNIQUE constraint below (task_id, reminder_type,
  // channel), not from restricting when this runs. vercel.json's three daily
  // schedules (4:30, 5:30, 10:00 UTC) just give multiple chances per day; only the
  // first one to find a given reminder still unsent will actually send it.

  if (!sql) return res.status(500).json({ error: 'Database not connected' });

  try {
    await ensureTables();

    const row = await sql`SELECT value FROM tna_kv WHERE key = 'tna:tna_data_v2'`;
    if (!row[0]) return res.status(200).json({ ok: true, message: 'No TNA data saved yet' });

    const DATA = JSON.parse(row[0].value);
    const today = new Date().toISOString().slice(0, 10);
    const results = { checked: 0, push: { sent: 0, skipped: 0, noToken: 0, failed: 0 }, email: { sent: 0, skipped: 0, noEmail: 0, failed: 0 } };
    const CHANNELS = ['push', 'email'];

    for (const order of (DATA.orders || [])) {
      for (const task of (order.tasks || [])) {
        const reminderType = classifyReminder(task, today);
        if (!reminderType) continue;
        results.checked++;

        const user = (DATA.users || []).find(u => u.id === task.assignedTo);
        if (!user) continue; // assigned user was deleted — nothing to notify

        for (const channel of CHANNELS) {
          // Claim this (task, reminderType, channel) slot. If another run already
          // claimed it, this insert fails and we skip — that's the idempotency
          // guarantee, and it's per-channel, so push and email never block each other.
          try {
            await sql`INSERT INTO notification_log (task_id, user_id, reminder_type, channel, status)
                       VALUES (${task.id}, ${user.id}, ${reminderType}, ${channel}, 'pending')`;
          } catch (e) {
            results[channel].skipped++;
            continue;
          }

          if (channel === 'push') {
            const tokenRows = await sql`SELECT token FROM notification_tokens WHERE user_id = ${user.id} AND active = true`;
            if (tokenRows.length === 0) {
              results.push.noToken++;
              await sql`UPDATE notification_log SET status = 'no_token'
                         WHERE task_id = ${task.id} AND user_id = ${user.id} AND reminder_type = ${reminderType} AND channel = 'push'`;
              continue;
            }

            let anySent = false;
            let lastError = null;
            for (const { token } of tokenRows) {
              try {
                await admin.messaging().send({
                  token,
                  notification: {
                    title: 'TNA Task Reminder',
                    body: `${task.name} — ${labelFor(reminderType)} (${fmtDate(opDate(task))})`,
                  },
                  webpush: { fcmOptions: { link: process.env.APP_URL || '/' } },
                  data: { taskId: String(task.id), orderId: String(order.id) },
                });
                anySent = true;
                await sql`UPDATE notification_tokens SET last_used_at = now() WHERE token = ${token}`;
              } catch (err) {
                lastError = err.message || String(err);
                // A token that's no longer valid gets deactivated so future runs
                // stop trying it — this never stops the loop from continuing on
                // to other tokens/users/tasks.
                if (err.code === 'messaging/registration-token-not-registered' ||
                    err.code === 'messaging/invalid-registration-token') {
                  await sql`UPDATE notification_tokens SET active = false WHERE token = ${token}`;
                }
              }
            }
            await sql`UPDATE notification_log SET status = ${anySent ? 'sent' : 'failed'}, error = ${lastError}
                       WHERE task_id = ${task.id} AND user_id = ${user.id} AND reminder_type = ${reminderType} AND channel = 'push'`;
            if (anySent) results.push.sent++; else results.push.failed++;

          } else if (channel === 'email') {
            if (!user.email) {
              results.email.noEmail++;
              await sql`UPDATE notification_log SET status = 'no_email'
                         WHERE task_id = ${task.id} AND user_id = ${user.id} AND reminder_type = ${reminderType} AND channel = 'email'`;
              continue;
            }
            try {
              // CC every manager assigned to this user's buyer — mirrors
              // managersForBuyer() in index.html, kept in sync deliberately.
              const managerEmails = (DATA.users || [])
                .filter(m => m.role === 'manager' && (m.managedBuyerIds || []).includes(user.buyerId) && m.email)
                .map(m => m.email);
              await sendEmail(user, user.email, managerEmails, task, order, reminderType);
              await sql`UPDATE notification_log SET status = 'sent'
                         WHERE task_id = ${task.id} AND user_id = ${user.id} AND reminder_type = ${reminderType} AND channel = 'email'`;
              results.email.sent++;
            } catch (err) {
              // An email failure (bad address, Resend outage, unverified-domain
              // restriction, etc.) is recorded and skipped over — it never stops
              // push notifications or any other task/user from being processed.
              await sql`UPDATE notification_log SET status = 'failed', error = ${err.message || String(err)}
                         WHERE task_id = ${task.id} AND user_id = ${user.id} AND reminder_type = ${reminderType} AND channel = 'email'`;
              results.email.failed++;
            }
          }
        }
      }
    }

    return res.status(200).json({ ok: true, date: today, results });
  } catch (err) {
    console.error('send-reminders error:', err);
    return res.status(500).json({ error: 'Reminder job failed', detail: err.message });
  }
}
