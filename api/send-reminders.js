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
function daysBetween(a, b) {
  const A = new Date(a + 'T00:00:00Z'), B = new Date(b + 'T00:00:00Z');
  return Math.round((B - A) / 86400000);
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

// Builds ONE email per person listing every task they currently have due —
// replaces the old one-email-per-task approach, which could mean several
// separate emails landing in someone's inbox on the same day for the same
// person. Overdue items are listed first (most urgent), then by due date.
function buildDigestEmail(user, items) {
  const appUrl = process.env.APP_URL || 'https://embee-tna-pcd.vercel.app';
  const firstName = (user.name || '').split(' ')[0] || 'there';
  const sorted = [...items].sort((a, b) => {
    const aOverdue = a.reminderType.startsWith('overdue');
    const bOverdue = b.reminderType.startsWith('overdue');
    if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
    return (opDate(a.task) || '').localeCompare(opDate(b.task) || '');
  });
  const subject = `TNA Task Reminder — ${items.length} task${items.length > 1 ? 's' : ''} need your attention`;
  const rows = sorted.map(({ task, order, reminderType }) => {
    const link = `${appUrl}/#order=${encodeURIComponent(order.id)}`;
    return `<tr>
      <td style="padding:8px 6px;border-bottom:1px solid #eee;">
        <a href="${link}" style="color:#17233A;text-decoration:none;font-weight:600;">${task.name}</a><br>
        <span style="font-size:12px;color:#666;">${order.styleNo || ''} — ${order.item || ''}</span>
      </td>
      <td style="padding:8px 6px;border-bottom:1px solid #eee;font-size:13px;white-space:nowrap;">${fmtDate(opDate(task))}</td>
      <td style="padding:8px 6px;border-bottom:1px solid #eee;font-size:13px;white-space:nowrap;">${labelFor(reminderType)}</td>
    </tr>`;
  }).join('');
  const html = `<div style="font-family:sans-serif;max-width:560px;color:#17233A;">
    <h2 style="margin-bottom:4px;">TNA Task Reminder</h2>
    <p>Dear ${firstName},</p>
    <p>You have ${items.length} task${items.length > 1 ? 's' : ''} needing attention:</p>
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr style="text-align:left;font-size:12px;color:#888;">
        <th style="padding:6px;">Task</th><th style="padding:6px;">Due date</th><th style="padding:6px;">Reminder</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
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
async function sendDigestEmail(user, items, managerEmails) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    throw new Error('GMAIL_USER / GMAIL_APP_PASSWORD not set');
  }
  const { subject, html } = buildDigestEmail(user, items);
  const mail = {
    from: `"TNA Reminders" <${process.env.GMAIL_USER}>`,
    to: user.email,
    subject,
    html,
  };
  if (managerEmails && managerEmails.length) mail.cc = managerEmails;
  await getGmailTransport().sendMail(mail);
}

// A task overdue this many days or more gets escalated: a dedicated email TO the
// buyer's manager(s) — not just CC'd on the assignee's routine digest — since
// something stuck that long usually needs someone above the assignee to actually
// chase it. Re-sent daily for as long as it stays this overdue, same "nags until
// resolved" philosophy as the regular overdue reminder above.
const ESCALATION_DAYS = 5;
function buildEscalationEmail(manager, items) {
  const appUrl = process.env.APP_URL || 'https://embee-tna-pcd.vercel.app';
  const firstName = (manager.name || '').split(' ')[0] || 'there';
  const sorted = [...items].sort((a, b) => b.daysLate - a.daysLate);
  const subject = `TNA Escalation — ${items.length} task${items.length > 1 ? 's' : ''} overdue ${ESCALATION_DAYS}+ days`;
  const rows = sorted.map(({ task, order, assigneeName, daysLate }) => {
    const link = `${appUrl}/#order=${encodeURIComponent(order.id)}`;
    return `<tr>
      <td style="padding:8px 6px;border-bottom:1px solid #eee;">
        <a href="${link}" style="color:#17233A;text-decoration:none;font-weight:600;">${task.name}</a><br>
        <span style="font-size:12px;color:#666;">${order.styleNo || ''} — ${order.item || ''}</span>
      </td>
      <td style="padding:8px 6px;border-bottom:1px solid #eee;font-size:13px;white-space:nowrap;">${assigneeName}</td>
      <td style="padding:8px 6px;border-bottom:1px solid #eee;font-size:13px;white-space:nowrap;color:#A83A33;font-weight:600;">${daysLate}d overdue</td>
    </tr>`;
  }).join('');
  const html = `<div style="font-family:sans-serif;max-width:560px;color:#17233A;">
    <h2 style="margin-bottom:4px;color:#A83A33;">TNA Escalation</h2>
    <p>Dear ${firstName},</p>
    <p>${items.length} task${items.length > 1 ? 's are' : ' is'} overdue by ${ESCALATION_DAYS}+ days and may need your attention beyond the assignee:</p>
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr style="text-align:left;font-size:12px;color:#888;">
        <th style="padding:6px;">Task</th><th style="padding:6px;">Assigned to</th><th style="padding:6px;">Status</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
  return { subject, html };
}
async function sendEscalationEmail(manager, items) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    throw new Error('GMAIL_USER / GMAIL_APP_PASSWORD not set');
  }
  const { subject, html } = buildEscalationEmail(manager, items);
  await getGmailTransport().sendMail({ from: `"TNA Reminders" <${process.env.GMAIL_USER}>`, to: manager.email, subject, html });
}

// Bounds the growth of tables that only ever get INSERTed into. Safe to run on every
// invocation (three times a day) — deleting rows older than a fixed cutoff is
// naturally idempotent. Only ever removes tokens already marked inactive (a currently
// active token is never touched here, regardless of how long it's been since it was
// last used — an unused-but-valid token belongs to someone with nothing due
// recently, not a dead token) and log rows old enough that nothing depends on them
// for idempotency (only recent rows for currently-open tasks matter for that).
async function cleanupOldRecords() {
  await sql`DELETE FROM notification_tokens WHERE active = false AND last_used_at < now() - INTERVAL '90 days'`;
  await sql`DELETE FROM notification_log WHERE sent_at < now() - INTERVAL '180 days'`;
  // weekly_report_log is created by api/bom-weekly-report.js, not this file — guard
  // separately so a fresh environment that's never run that job doesn't fail the
  // whole cleanup pass over one table that may not exist yet.
  try {
    await sql`DELETE FROM weekly_report_log WHERE sent_at < now() - INTERVAL '365 days'`;
  } catch (e) {
    console.warn('weekly_report_log cleanup skipped (table not present yet?):', e.message);
  }
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
    try { await cleanupOldRecords(); } catch (e) { console.warn('Cleanup pass failed (non-fatal):', e.message); }

    const row = await sql`SELECT value FROM tna_kv WHERE key = 'tna:tna_data_v2'`;
    if (!row[0]) return res.status(200).json({ ok: true, message: 'No TNA data saved yet' });

    const DATA = JSON.parse(row[0].value);
    const today = new Date().toISOString().slice(0, 10);
    const results = { checked: 0, push: { sent: 0, skipped: 0, noToken: 0, failed: 0 }, email: { sent: 0, skipped: 0, noEmail: 0, failed: 0 } };

    // Email is batched — every qualifying task is CLAIMED here (same idempotency
    // guarantee as before, per task/reminderType), but not sent individually.
    // Claimed items are grouped by person into emailBatches, then AFTER this loop
    // each person gets exactly one combined email listing everything they have due.
    // Push notifications are unaffected — those still go out per task immediately,
    // since a phone notification isn't inbox clutter the way repeated emails are.
    const emailBatches = {}; // userId -> { user, items: [{task, order, reminderType}] }

    for (const order of (DATA.orders || [])) {
      for (const task of (order.tasks || [])) {
        const reminderType = classifyReminder(task, today);
        if (!reminderType) continue;
        results.checked++;

        const user = (DATA.users || []).find(u => u.id === task.assignedTo);
        if (!user) continue; // assigned user was deleted — nothing to notify

        // --- push: unchanged, one notification per task, sent immediately ---
        try {
          await sql`INSERT INTO notification_log (task_id, user_id, reminder_type, channel, status)
                     VALUES (${task.id}, ${user.id}, ${reminderType}, 'push', 'pending')`;

          const tokenRows = await sql`SELECT token FROM notification_tokens WHERE user_id = ${user.id} AND active = true`;
          if (tokenRows.length === 0) {
            results.push.noToken++;
            await sql`UPDATE notification_log SET status = 'no_token'
                       WHERE task_id = ${task.id} AND user_id = ${user.id} AND reminder_type = ${reminderType} AND channel = 'push'`;
          } else {
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
                if (err.code === 'messaging/registration-token-not-registered' ||
                    err.code === 'messaging/invalid-registration-token') {
                  await sql`UPDATE notification_tokens SET active = false WHERE token = ${token}`;
                }
              }
            }
            await sql`UPDATE notification_log SET status = ${anySent ? 'sent' : 'failed'}, error = ${lastError}
                       WHERE task_id = ${task.id} AND user_id = ${user.id} AND reminder_type = ${reminderType} AND channel = 'push'`;
            if (anySent) results.push.sent++; else results.push.failed++;
          }
        } catch (e) {
          results.push.skipped++; // already claimed by an earlier run
        }

        // --- email: claim the slot, but queue it into a per-person batch
        //     instead of sending right away ---
        try {
          await sql`INSERT INTO notification_log (task_id, user_id, reminder_type, channel, status)
                     VALUES (${task.id}, ${user.id}, ${reminderType}, 'email', 'pending')`;
        } catch (e) {
          results.email.skipped++;
          continue;
        }
        if (!user.email) {
          results.email.noEmail++;
          await sql`UPDATE notification_log SET status = 'no_email'
                     WHERE task_id = ${task.id} AND user_id = ${user.id} AND reminder_type = ${reminderType} AND channel = 'email'`;
          continue;
        }
        if (!emailBatches[user.id]) emailBatches[user.id] = { user, items: [] };
        emailBatches[user.id].items.push({ task, order, reminderType });
      }
    }

    // One email per person, covering every task claimed above for them.
    for (const userId of Object.keys(emailBatches)) {
      const { user, items } = emailBatches[userId];
      // CC every manager for every buyer represented in this person's batch — a
      // merchandiser handling multiple buyers gets each relevant buyer's manager
      // copied, not just one. Mirrors managersForBuyer() in index.html.
      const buyerIds = [...new Set(items.map(i => i.order.buyerId))];
      const managerEmails = [...new Set(
        (DATA.users || [])
          .filter(m => m.role === 'manager' && buyerIds.some(bid => (m.managedBuyerIds || []).includes(bid)) && m.email)
          .map(m => m.email)
      )];
      try {
        await sendDigestEmail(user, items, managerEmails);
        for (const { task, reminderType } of items) {
          await sql`UPDATE notification_log SET status = 'sent'
                     WHERE task_id = ${task.id} AND user_id = ${user.id} AND reminder_type = ${reminderType} AND channel = 'email'`;
        }
        results.email.sent += items.length;
      } catch (err) {
        // One failed email doesn't lose the claim silently — every task in the
        // batch is marked failed so it's visible, and nothing here stops the
        // next person's batch from still being attempted.
        for (const { task, reminderType } of items) {
          await sql`UPDATE notification_log SET status = 'failed', error = ${err.message || String(err)}
                     WHERE task_id = ${task.id} AND user_id = ${user.id} AND reminder_type = ${reminderType} AND channel = 'email'`;
        }
        results.email.failed += items.length;
      }
    }

    // Escalation: tasks overdue ESCALATION_DAYS+ get a direct email to the buyer's
    // manager(s) — separate from the CC they already get on the assignee's routine
    // digest above, and addressed TO them so it reads as urgent, not routine. One
    // digest per manager per day (not one email per task), claimed via
    // notification_log exactly like the reminders above — the manager id is baked
    // into reminder_type itself (escalation_<date>_<managerId>) so the existing
    // (task_id, reminder_type, channel) UNIQUE constraint still gives correct
    // per-manager idempotency without any schema change, the same way overdue
    // reminders already bake the date into their own reminder_type.
    const escalationBatches = {}; // managerId -> { manager, items: [{task, order, assigneeName, daysLate, escalationType}] }
    for (const order of (DATA.orders || [])) {
      for (const task of (order.tasks || [])) {
        if (!isOpenTask(task) || !task.assignedTo) continue;
        const due = opDate(task);
        if (!due || due >= today) continue;
        const daysLate = daysBetween(due, today);
        if (daysLate < ESCALATION_DAYS) continue;

        const managers = (DATA.users || []).filter(m => m.role === 'manager' && (m.managedBuyerIds || []).includes(order.buyerId) && m.email);
        for (const manager of managers) {
          const escalationType = `escalation_${today}_${manager.id}`;
          try {
            await sql`INSERT INTO notification_log (task_id, user_id, reminder_type, channel, status)
                       VALUES (${task.id}, ${manager.id}, ${escalationType}, 'email', 'pending')`;
          } catch (e) {
            continue; // already claimed for this manager today
          }
          const assignee = (DATA.users || []).find(u => u.id === task.assignedTo);
          if (!escalationBatches[manager.id]) escalationBatches[manager.id] = { manager, items: [] };
          escalationBatches[manager.id].items.push({ task, order, assigneeName: assignee ? assignee.name : 'Unassigned', daysLate, escalationType });
        }
      }
    }

    results.escalation = { sent: 0, failed: 0 };
    for (const managerId of Object.keys(escalationBatches)) {
      const { manager, items } = escalationBatches[managerId];
      try {
        await sendEscalationEmail(manager, items);
        for (const { task, escalationType } of items) {
          await sql`UPDATE notification_log SET status = 'sent'
                     WHERE task_id = ${task.id} AND user_id = ${manager.id} AND reminder_type = ${escalationType} AND channel = 'email'`;
        }
        results.escalation.sent += items.length;
      } catch (err) {
        for (const { task, escalationType } of items) {
          await sql`UPDATE notification_log SET status = 'failed', error = ${err.message || String(err)}
                     WHERE task_id = ${task.id} AND user_id = ${manager.id} AND reminder_type = ${escalationType} AND channel = 'email'`;
        }
        results.escalation.failed += items.length;
      }
    }

    return res.status(200).json({ ok: true, date: today, results, emailsSent: Object.keys(emailBatches).length, escalationsSent: Object.keys(escalationBatches).length });
  } catch (err) {
    console.error('send-reminders error:', err);
    return res.status(500).json({ error: 'Reminder job failed', detail: err.message });
  }
}
