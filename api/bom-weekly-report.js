// Weekly BOM status report — triggered by Vercel Cron (see vercel.json).
// Every Saturday (~1 PM Cairo time), this generates one PDF per buyer — each
// showing that buyer's styles grouped together, with every BOM/material line
// (fabric, trim, etc.) and its risk level, plus the PCD (Production
// Commencement Date) each material is required by. All the buyer PDFs go out
// as attachments on a single email to everyone in the PPC department, so
// planning has one place to see raw-material status across every buyer.
//
// Two Saturday schedules (10:00 and 11:00 UTC) bracket Cairo's DST switch —
// same reasoning as api/send-reminders.js. No exact-hour gate is used (that
// approach caused missed sends before — see that file's history); instead,
// weekly_report_log's UNIQUE constraint on the ISO week ensures only the
// first of the two triggers each week actually generates and sends anything.

import { neon } from '@neondatabase/serverless';
import nodemailer from 'nodemailer';
import { jsPDF } from 'jspdf';

const connectionString =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.STORAGE_URL ||
  process.env.STORAGE_DATABASE_URL ||
  process.env.DATABASE_URL_UNPOOLED ||
  process.env.STORAGE_DATABASE_URL_UNPOOLED ||
  process.env.POSTGRES_PRISMA_URL;
const sql = connectionString ? neon(connectionString) : null;

// Mirrors index.html's isOpenTask / opDate / qtyPercent / balanceQty /
// daysBetween — kept in sync deliberately, same reasoning as the other two
// backend files: sharing code across the static HTML file and serverless
// functions would add more risk than it removes.
const RESOLVED_STATUSES = ['Done', 'Approved', 'Rejected', 'N/A'];
function isOpenTask(t) { return !RESOLVED_STATUSES.includes(t.status); }
function opDate(t) { return t.expectedDate || t.plannedDate; }
function daysBetween(a, b) {
  if (!a || !b) return 0;
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
function qtyPercent(t) {
  if (!t.materialType || !t.requiredQty) return null;
  return Math.round(((t.receivedQty || 0) / t.requiredQty) * 100);
}
function balanceQty(t) {
  if (!t.materialType || !t.requiredQty) return null;
  return Math.max(0, t.requiredQty - (t.receivedQty || 0));
}
// Per-material risk level — same red/amber/green thinking as orderRAG() in
// index.html, just scoped to a single BOM row instead of a whole order.
function bomRiskLevel(t, order) {
  const pct = qtyPercent(t);
  if (pct !== null && pct >= 100) return 'green';
  if (!isOpenTask(t)) return 'green';
  const due = opDate(t);
  if (due && due < todayISO()) return 'red';
  if (order.pcd && due && due > order.pcd) return 'red';
  if (due && daysBetween(todayISO(), due) <= 3) return 'amber';
  return 'green';
}
function todayISO() { return new Date().toISOString().slice(0, 10); }
const RISK_LABEL = { red: 'At risk', amber: 'Watch', green: 'On track' };

async function ensureTables() {
  await sql`CREATE TABLE IF NOT EXISTS weekly_report_log (
    id SERIAL PRIMARY KEY, week_key TEXT NOT NULL UNIQUE,
    sent_at TIMESTAMPTZ DEFAULT now(), buyer_count INTEGER, status TEXT
  )`;
}
// ISO week string like "2026-W34" — used as the once-per-week idempotency key.
function isoWeekKey(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((date - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function pdfHeader(doc, title, subtitle) {
  doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
  doc.text(title, 40, 36);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(100);
  doc.text(subtitle, 40, 52);
  doc.setTextColor(0);
  return 72;
}
function pdfSectionTitle(doc, y, text) {
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
  doc.text(text, 40, y);
  doc.setFont('helvetica', 'normal');
  return y + 14;
}
// Minimal hand-rolled table renderer — same approach as pdfTable() in
// index.html (no autotable plugin dependency, for reliability). Colors the
// Risk cell's text so it's visually obvious without needing a legend.
function pdfTable(doc, y, headers, rows, colWidths, marginLeft = 40) {
  const pageHeight = doc.internal.pageSize.getHeight();
  const rowH = 16;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5);
  let x = marginLeft;
  headers.forEach((h, i) => { doc.text(String(h), x, y); x += colWidths[i]; });
  y += 6;
  doc.setDrawColor(200); doc.line(marginLeft, y, marginLeft + colWidths.reduce((a, b) => a + b, 0), y);
  y += 10;
  doc.setFont('helvetica', 'normal');
  for (const row of rows) {
    if (y > pageHeight - 40) { doc.addPage(); y = 40; }
    x = marginLeft;
    row.forEach((cell, i) => {
      if (headers[i] === 'Risk') {
        const risk = String(cell).toLowerCase();
        if (risk.includes('at risk')) doc.setTextColor(193, 68, 60);
        else if (risk.includes('watch')) doc.setTextColor(184, 134, 46);
        else doc.setTextColor(62, 122, 78);
      }
      doc.text(String(cell), x, y);
      doc.setTextColor(0);
      x += colWidths[i];
    });
    y += rowH;
  }
  return y;
}

// Builds one buyer's PDF: every style (order) with at least one BOM/material
// task, each style's materials listed with quantities, required-by (PCD)
// date, and risk level.
function buildBuyerPdf(buyer, orders) {
  const totalMaterials = orders.reduce((sum, o) => sum + o.tasks.filter(t => t.materialType).length, 0);
  const atRiskCount = orders.reduce((sum, o) => sum + o.tasks.filter(t => t.materialType && bomRiskLevel(t, o) === 'red').length, 0);
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  let y = pdfHeader(doc, `Weekly BOM Status — ${buyer.name}`,
    `${orders.length} style${orders.length !== 1 ? 's' : ''} · ${totalMaterials} material line${totalMaterials !== 1 ? 's' : ''} · ${atRiskCount} at risk · Generated ${new Date().toLocaleString()}`);

  for (const order of orders) {
    const materials = order.tasks.filter(t => t.materialType);
    if (y > doc.internal.pageSize.getHeight() - 120) { doc.addPage(); y = 40; }
    y = pdfSectionTitle(doc, y, `${order.styleNo || '(no style no.)'}${order.item ? ' — ' + order.item : ''}  ·  PCD ${fmtDate(order.pcd)}${order.season ? '  ·  ' + order.season : ''}`);
    y = pdfTable(doc, y,
      ['Material', 'Required', 'Unit', 'Supplier', 'Required by (PCD)', 'Received', 'Balance', '% ready', 'Risk'],
      materials.map(t => {
        const pct = qtyPercent(t);
        const bal = balanceQty(t);
        return [
          t.materialType, t.requiredQty ?? '—', t.unit || '—', t.supplier || '—',
          fmtDate(order.pcd), t.receivedQty ?? '—', bal === null ? '—' : bal,
          pct === null ? '—' : pct + '%', RISK_LABEL[bomRiskLevel(t, order)],
        ];
      }),
      [110, 60, 50, 100, 90, 60, 55, 55, 60]
    );
    y += 14;
  }
  return Buffer.from(doc.output('arraybuffer'));
}

let gmailTransport = null;
function getGmailTransport() {
  if (!gmailTransport) {
    gmailTransport = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });
  }
  return gmailTransport;
}

export default async function handler(req, res) {
  const auth = req.headers['authorization'];
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!sql) return res.status(500).json({ error: 'Database not connected' });

  try {
    await ensureTables();
    // Parsed via the WHATWG URL API rather than the request's auto-populated `.query`
    // (which Vercel's Node runtime derives internally using the legacy, deprecated
    // `url.parse()` — DEP0169). This sidesteps that entirely instead of just moving it.
    const isTestRun = new URL(req.url, 'http://localhost').searchParams.get('test') === '1';
    const weekKey = isoWeekKey(new Date());

    if (!isTestRun) {
      try {
        await sql`INSERT INTO weekly_report_log (week_key, status) VALUES (${weekKey}, 'pending')`;
      } catch (e) {
        return res.status(200).json({ ok: true, skipped: true, reason: `Already sent for ${weekKey}` });
      }
    }

    const row = await sql`SELECT value FROM tna_kv WHERE key = 'tna:tna_data_v2'`;
    if (!row[0]) return res.status(200).json({ ok: true, message: 'No TNA data saved yet' });
    const DATA = JSON.parse(row[0].value);

    const ppcEmails = (DATA.users || [])
      .filter(u => u.dept === 'PPC' && u.email)
      .map(u => u.email);

    if (ppcEmails.length === 0) {
      if (!isTestRun) await sql`UPDATE weekly_report_log SET status = 'no_recipients' WHERE week_key = ${weekKey}`;
      return res.status(200).json({ ok: true, message: 'No users assigned to the PPC department yet — nothing sent' });
    }

    const attachments = [];
    for (const buyer of (DATA.buyers || [])) {
      const orders = (DATA.orders || []).filter(o => o.buyerId === buyer.id && o.tasks.some(t => t.materialType));
      if (orders.length === 0) continue;
      const pdfBuffer = buildBuyerPdf(buyer, orders);
      attachments.push({
        filename: `BOM-status-${buyer.name.replace(/[^a-z0-9]/gi, '_')}-${weekKey}.pdf`,
        content: pdfBuffer,
      });
    }

    if (attachments.length === 0) {
      if (!isTestRun) await sql`UPDATE weekly_report_log SET status = 'no_data' WHERE week_key = ${weekKey}`;
      return res.status(200).json({ ok: true, message: 'No buyers currently have BOM data — nothing to report' });
    }

    if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
      throw new Error('GMAIL_USER / GMAIL_APP_PASSWORD not set');
    }

    await getGmailTransport().sendMail({
      from: `"TNA Reminders" <${process.env.GMAIL_USER}>`,
      to: ppcEmails,
      subject: `Weekly BOM status report — ${attachments.length} buyer${attachments.length !== 1 ? 's' : ''} (${weekKey})`,
      html: `<div style="font-family:sans-serif;color:#17233A;">
        <p>Attached: this week's BOM/raw-material status, one PDF per buyer, styles grouped with quantities, required-by (PCD) date, and risk level for each material.</p>
        <p>${attachments.length} buyer file${attachments.length !== 1 ? 's' : ''} attached.</p>
      </div>`,
      attachments,
    });

    if (!isTestRun) await sql`UPDATE weekly_report_log SET status = 'sent', buyer_count = ${attachments.length} WHERE week_key = ${weekKey}`;
    return res.status(200).json({ ok: true, weekKey, buyersSent: attachments.length, recipients: ppcEmails });
  } catch (err) {
    console.error('bom-weekly-report error:', err);
    return res.status(500).json({ error: 'Weekly report job failed', detail: err.message });
  }
}
