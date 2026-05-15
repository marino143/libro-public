#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
//  libro — tiny local server
//  ────────────────────────────────────────────────────────────────────
//  Replace za python -m http.server. Serves static files + dodatni endpoint-i:
//
//    GET  /*                    → static file (dashboard, JSON, PDF, XML)
//    POST /api/upload           → sprema PDF u Invoice 2026/Placanje MMM YY/Supplier/
//    POST /api/rebuild          → pokreće local-libro.mjs (regenerira libro-data.json)
//    POST /api/ignore           → ignorira transakciju (čuva u libro-ignored.json)
//    POST /api/open             → otvara local file u Finder/Preview (macOS `open`)
//
//  Usage:  node libro-server.mjs [port=8765]
// ═══════════════════════════════════════════════════════════════════════════

import { createServer } from 'http';
import { readFile, writeFile, mkdir, stat } from 'fs/promises';
import { createReadStream, existsSync, readFileSync, statSync } from 'fs';
import { extname, join, dirname, resolve, normalize, sep } from 'path';
import { spawn } from 'child_process';
import { URL } from 'url';
import {
  getConfig,
  isFirstRun,
  saveConfig,
  folderPath,
  defaultYear,
  isAIEnabled,
  isAccountingEnabled,
  isGmailEnabled,
  getAccountantEmails,
  getDefaultRecipient,
  getSupplier,
} from './libro-config.mjs';

const ROOT = process.cwd();
const PORT = Number(process.argv[2] || process.env.PORT || 8765);

// Config-driven folder paths — replace hardkodirane "IZVODI CO {year}" / "Invoice {year}".
function bankDir(year) { return folderPath('bankStatements', year); }
function invoiceDir(year) { return folderPath('incomingInvoices', year); }
function outgoingDir(year) { return folderPath('outgoingInvoices', year); }
function accountantDocsDir() { return folderPath('accountantDocs'); }

// ───────────────────────────────────────────────────────────
// .env loader (no npm dep)
// ───────────────────────────────────────────────────────────
function loadEnv() {
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) return {};
  const env = {};
  try {
    readFileSync(envPath, 'utf8').split('\n').forEach(line => {
      line = line.trim();
      if (!line || line.startsWith('#')) return;
      const eq = line.indexOf('=');
      if (eq < 0) return;  // tolerira loše linije (stray chars)
      const key = line.substring(0, eq).trim();
      const value = line.substring(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      if (key) env[key] = value;
    });
  } catch (e) {
    console.warn('⚠ .env parse fail: ' + e.message);
  }
  return env;
}
const ENV = loadEnv();
const ANTHROPIC_API_KEY = (ENV.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '').trim();
const ANTHROPIC_MODEL = ENV.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const ANTHROPIC_DAILY_LIMIT_USD = Number(ENV.ANTHROPIC_DAILY_LIMIT_USD || 2);
const GAS_WEBAPP_URL = (ENV.GAS_WEBAPP_URL || process.env.GAS_WEBAPP_URL || '').trim();
const GMAIL_CLIENT_ID = (ENV.GMAIL_CLIENT_ID || process.env.GMAIL_CLIENT_ID || '').trim();
const GMAIL_CLIENT_SECRET = (ENV.GMAIL_CLIENT_SECRET || process.env.GMAIL_CLIENT_SECRET || '').trim();
const GMAIL_REFRESH_TOKEN = (ENV.GMAIL_REFRESH_TOKEN || process.env.GMAIL_REFRESH_TOKEN || '').trim();
// Drugi (secondary) Gmail account — opcijski. Reuse client_id ako nije zaseban.
const GMAIL2_CLIENT_ID = (ENV.GMAIL2_CLIENT_ID || GMAIL_CLIENT_ID).trim();
const GMAIL2_CLIENT_SECRET = (ENV.GMAIL2_CLIENT_SECRET || GMAIL_CLIENT_SECRET).trim();
const GMAIL2_REFRESH_TOKEN = (ENV.GMAIL2_REFRESH_TOKEN || '').trim();

// In-memory cache za Gmail access token (per account)
const _tokenCache = {};

async function getGmailAccessToken(account = 'primary') {
  const cached = _tokenCache[account];
  if (cached && Date.now() < cached.expiry - 60000) return cached.token;
  const cfg = account === 'secondary'
    ? { id: GMAIL2_CLIENT_ID, secret: GMAIL2_CLIENT_SECRET, refresh: GMAIL2_REFRESH_TOKEN }
    : { id: GMAIL_CLIENT_ID, secret: GMAIL_CLIENT_SECRET, refresh: GMAIL_REFRESH_TOKEN };
  if (!cfg.refresh) {
    throw new Error((account === 'secondary' ? 'GMAIL2_REFRESH_TOKEN' : 'GMAIL_REFRESH_TOKEN') + ' nije postavljen — pokreni: node setup-gmail-auth.mjs' + (account === 'secondary' ? ' --secondary' : ''));
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.id, client_secret: cfg.secret,
      refresh_token: cfg.refresh, grant_type: 'refresh_token',
    }).toString(),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('OAuth refresh fail (' + account + '): ' + JSON.stringify(data));
  _tokenCache[account] = { token: data.access_token, expiry: Date.now() + (data.expires_in || 3600) * 1000 };
  return data.access_token;
}

async function gmailApi(endpoint, accessToken) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/${endpoint}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { throw new Error('Gmail API non-JSON response: ' + text.slice(0, 200)); }
}

// Vraca listu accounts koje treba pretraziti (uvijek primary, plus secondary ako je setupiran)
function getActiveGmailAccounts() {
  const arr = [];
  if (GMAIL_REFRESH_TOKEN) arr.push('primary');
  if (GMAIL2_REFRESH_TOKEN) arr.push('secondary');
  return arr;
}

// Helper: gmail API POST/PUT
async function gmailApiPost(endpoint, body, accessToken, method = 'POST') {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error('Gmail API ' + method + ' ' + endpoint + ' fail: ' + text.slice(0, 300));
  try { return JSON.parse(text); } catch { return {}; }
}

// Find or create label on Gmail (returns labelId)
async function getOrCreateGmailLabel(name, accessToken) {
  const list = await gmailApi('users/me/labels', accessToken);
  const found = (list.labels || []).find(l => l.name === name);
  if (found) return found.id;
  const created = await gmailApiPost('users/me/labels', {
    name, labelListVisibility: 'labelShow', messageListVisibility: 'show',
  }, accessToken);
  return created.id;
}

// Build RFC822 message s attachmentima (base64 attachments)
function buildRfc822Email({ from, to, subject, body, attachments }) {
  const boundary = '----libro' + Date.now();
  const parts = [];
  parts.push('From: ' + from);
  parts.push('To: ' + to);
  parts.push('Subject: =?utf-8?B?' + Buffer.from(subject, 'utf8').toString('base64') + '?=');
  parts.push('MIME-Version: 1.0');
  parts.push('Content-Type: multipart/mixed; boundary="' + boundary + '"');
  parts.push('');
  parts.push('--' + boundary);
  parts.push('Content-Type: text/plain; charset="utf-8"');
  parts.push('Content-Transfer-Encoding: 7bit');
  parts.push('');
  parts.push(body);
  parts.push('');
  for (const att of attachments) {
    parts.push('--' + boundary);
    parts.push('Content-Type: ' + (att.mimeType || 'application/octet-stream') + '; name="' + att.filename + '"');
    parts.push('Content-Disposition: attachment; filename="' + att.filename + '"');
    parts.push('Content-Transfer-Encoding: base64');
    parts.push('');
    // Base64 wrap u 76 char redove
    const b64 = att.contentBase64;
    for (let i = 0; i < b64.length; i += 76) parts.push(b64.slice(i, i + 76));
    parts.push('');
  }
  parts.push('--' + boundary + '--');
  return parts.join('\r\n');
}

// Send Gmail message preko Gmail API. Vrati messageId.
async function sendGmailMessage(rfc822, accessToken) {
  const raw = Buffer.from(rfc822, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const result = await gmailApiPost('users/me/messages/send', { raw }, accessToken);
  return result.id;
}

// Archive thread (remove INBOX label)
async function archiveGmailThread(threadId, accessToken, addLabelIds = []) {
  return await gmailApiPost(
    `users/me/threads/${threadId}/modify`,
    { removeLabelIds: ['INBOX'], addLabelIds },
    accessToken
  );
}

function findAttachmentsInPayload(payload) {
  const out = [];
  function walk(part) {
    if (part.filename && part.body && part.body.attachmentId) {
      out.push({ filename: part.filename, attachmentId: part.body.attachmentId });
    }
    if (part.parts) part.parts.forEach(walk);
  }
  if (payload) walk(payload);
  return out;
}
const CLAUDE_USAGE_FILE = join(ROOT, 'libro-claude-usage.json');
const IGNORED_FILE = join(ROOT, 'libro-ignored.json');
const FORWARDED_FILE = join(ROOT, 'libro-forwarded.json');
const EMAILS_SENT_FILE = join(ROOT, 'libro-emails-sent.json');
const INVOICE_METADATA_FILE = join(ROOT, 'libro-invoice-metadata.json');
const NOT_SENT_STMTS_FILE = join(ROOT, 'libro-not-sent-statements.json');
const BANK_EMAILS_SENT_FILE = join(ROOT, 'libro-bank-emails-sent.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.pdf':  'application/pdf',
  '.xml':  'application/xml; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
};

// ───────────────────────────────────────────────────────────
// HELPERS
// ───────────────────────────────────────────────────────────
function json(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(obj, null, 2));
}

async function readBody(req, limitBytes = 50 * 1024 * 1024) {
  return new Promise((done, fail) => {
    const chunks = [];
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > limitBytes) {
        fail(new Error('Body too large (>' + (limitBytes / 1024 / 1024) + 'MB)'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => done(Buffer.concat(chunks)));
    req.on('error', fail);
  });
}

// Sigurno resolvat path unutar ROOT-a (spriječi ../ traversals)
function safeJoin(rel) {
  const resolved = resolve(ROOT, rel.replace(/^\//, ''));
  if (!resolved.startsWith(ROOT + sep) && resolved !== ROOT) {
    throw new Error('Path outside root: ' + rel);
  }
  return resolved;
}

function sanitizeFileName(s) {
  return String(s || 'file.pdf').replace(/[\/\\:*?"<>|]/g, '_').trim() || 'file.pdf';
}

function sanitizeFolder(s) {
  return String(s || 'Ostalo').replace(/[\/\\:*?"<>|]/g, '_').trim().slice(0, 60) || 'Ostalo';
}

// "2026-04" → "Placanje Apr 26"  (match user-ov folder stil)
const MMM_EN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function periodToPlacanje(period) {
  const m = String(period || '').match(/^(\d{4})-(\d{2})/);
  if (!m) return null;
  const mmm = MMM_EN[parseInt(m[2], 10) - 1];
  const yy = m[1].slice(2);
  return `Placanje ${mmm} ${yy}`;
}

// ───────────────────────────────────────────────────────────
// ROUTES
// ───────────────────────────────────────────────────────────
async function handleUpload(req, res) {
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body.toString('utf8'));

    if (!payload.fileBase64) return json(res, 400, { error: 'Missing fileBase64' });
    if (!payload.fileName)   return json(res, 400, { error: 'Missing fileName' });
    if (!payload.supplier)   return json(res, 400, { error: 'Missing supplier' });

    const kind = (payload.kind || 'INVOICE').toUpperCase();
    const year = String(payload.year || new Date().getFullYear());
    const period = payload.period || (new Date().toISOString().slice(0, 7));

    let targetDir;
    if (kind === 'INVOICE') {
      const placanje = periodToPlacanje(period) || 'Placanje Ostalo';
      targetDir = join(invoiceDir(year), placanje, sanitizeFolder(payload.supplier));
    } else {
      // BANK statements — config-driven folder
      targetDir = bankDir(year);
    }

    await mkdir(targetDir, { recursive: true });

    const fileName = sanitizeFileName(payload.fileName);
    const filePath = join(targetDir, fileName);

    // Dupe check
    if (existsSync(filePath)) {
      return json(res, 200, {
        success: true,
        duplicate: true,
        path: filePath.replace(ROOT + sep, ''),
        message: 'Već postoji — nije prepisano',
      });
    }

    const bytes = Buffer.from(payload.fileBase64, 'base64');
    await writeFile(filePath, bytes);

    // Auto-rebuild (async, ne blokiramo response)
    spawn(process.execPath, ['local-libro.mjs'], { cwd: ROOT, stdio: 'ignore', detached: true }).unref();

    return json(res, 200, {
      success: true,
      duplicate: false,
      path: filePath.replace(ROOT + sep, ''),
      folder: targetDir.replace(ROOT + sep, ''),
      filename: fileName,
      sizeBytes: bytes.length,
      rebuildStarted: true,
    });
  } catch (err) {
    console.error('upload error:', err);
    return json(res, 500, { error: err.message });
  }
}

async function handleRebuild(req, res) {
  try {
    const proc = spawn(process.execPath, ['local-libro.mjs'], { cwd: ROOT });
    let out = '';
    proc.stdout.on('data', c => out += c.toString());
    proc.stderr.on('data', c => out += c.toString());
    proc.on('close', code => {
      if (code === 0) json(res, 200, { success: true, log: out });
      else json(res, 500, { success: false, code, log: out });
    });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

async function handleIgnore(req, res) {
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body.toString('utf8'));
    if (!payload.ref) return json(res, 400, { error: 'Missing ref' });

    let ignored = {};
    try {
      const raw = await readFile(IGNORED_FILE, 'utf8');
      ignored = JSON.parse(raw);
    } catch (_) { /* file doesn't exist yet */ }

    if (payload.action === 'unignore') {
      delete ignored[payload.ref];
    } else {
      ignored[payload.ref] = {
        note: payload.note || '',
        at: new Date().toISOString(),
      };
    }
    await writeFile(IGNORED_FILE, JSON.stringify(ignored, null, 2));

    // Auto-rebuild
    spawn(process.execPath, ['local-libro.mjs'], { cwd: ROOT, stdio: 'ignore', detached: true }).unref();

    return json(res, 200, { success: true, ignored: Object.keys(ignored).length });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

async function handleSendInvoiceEmail(req, res) {
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body.toString('utf8'));
    if (!payload.path) return json(res, 400, { error: 'Missing path' });

    const fullPath = safeJoin(payload.path);
    if (!existsSync(fullPath)) return json(res, 404, { error: 'File not found: ' + payload.path });

    const recipient = payload.to || getDefaultRecipient();
    if (!recipient) return json(res, 400, { error: 'Nema recipient-a: postavi `accounting.eRacuniInbox` ili `accounting.primaryEmail` u libro-config.json' });
    const subject = payload.subject || ('[libro.] ' + (payload.supplier || '') + ' · ' + fullPath.split(sep).pop());
    const bodyTxt = payload.body ||
      'U prilogu račun od dobavljača ' + (payload.supplier || '') + '.\n\n' +
      'Razdoblje: ' + (payload.period || '') + '\n' +
      'Datoteka: ' + payload.path + '\n\n— libro.';

    // Pokušaj AppleScript → Apple Mail s attachmentom (macOS native, najbolja opcija)
    const escStr = s => String(s).replace(/"/g, '\\"').replace(/\\/g, '\\\\');
    const appleScript = `
      tell application "Mail"
        set newMsg to make new outgoing message with properties {subject:"${escStr(subject)}", content:"${escStr(bodyTxt)}\\n", visible:true}
        tell newMsg
          make new to recipient at end of to recipients with properties {address:"${escStr(recipient)}"}
          tell content
            make new attachment with properties {file name:POSIX file "${escStr(fullPath)}"} at after last paragraph
          end tell
        end tell
        activate
      end tell`;

    const method = payload.method || 'applescript';  // 'applescript' | 'mailto' | 'log'

    if (method === 'log') {
      // Samo zabilježi kao poslano — korisno ako user je sam poslao iz Gmail-a
      await saveEmailSent(payload.path, recipient, payload.supplier || '', 'log');
      spawn(process.execPath, ['local-libro.mjs'], { cwd: ROOT, stdio: 'ignore', detached: true }).unref();
      return json(res, 200, { success: true, method: 'log' });
    }

    if (method === 'applescript') {
      try {
        const proc = spawn('osascript', ['-e', appleScript], { cwd: ROOT });
        let stderr = '';
        proc.stderr.on('data', c => stderr += c.toString());
        proc.on('close', async (code) => {
          if (code === 0) {
            // Ne pamti kao "sent" dok user ne klikne Send u Mail.app-u — samo je compose otvoren
            json(res, 200, { success: true, method: 'applescript', composed: true });
          } else {
            json(res, 500, { success: false, method: 'applescript', error: stderr || 'osascript exited ' + code });
          }
        });
        return;
      } catch (err) {
        return json(res, 500, { error: 'AppleScript failed: ' + err.message });
      }
    }

    // Fallback: mailto (user attacha manualno)
    return json(res, 200, {
      success: true,
      method: 'mailto',
      mailto: `mailto:${recipient}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyTxt + '\n\n(attach: ' + fullPath + ')')}`,
      path: fullPath,
    });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

async function saveEmailSent(path, to, supplier, method) {
  let sent = {};
  try {
    sent = JSON.parse(await readFile(EMAILS_SENT_FILE, 'utf8'));
  } catch (_) { /* file doesn't exist yet */ }
  sent[path] = {
    at: new Date().toISOString(),
    to: to,
    supplier: supplier,
    method: method,
  };
  await writeFile(EMAILS_SENT_FILE, JSON.stringify(sent, null, 2));
}

/**
 * Pošalji bankovni izvod (XML + PDF attachmenti) knjigovodstvu preko Mail.app.
 * Payload: { xmlFile, pdfFile, date, to? }
 */
async function handleSendStatementEmail(req, res) {
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body.toString('utf8'));
    if (!payload.xmlFile) return json(res, 400, { error: 'Missing xmlFile' });

    const bankYear = payload.year || defaultYear();
    const bankFolderRel = bankDir(bankYear).slice(ROOT.length).replace(/^[\\/]+/, '') + '/';
    const xmlPath = safeJoin(bankFolderRel + payload.xmlFile);
    if (!existsSync(xmlPath)) return json(res, 404, { error: 'XML not found' });

    let pdfPath = '';
    if (payload.pdfFile) {
      pdfPath = safeJoin(bankFolderRel + payload.pdfFile);
      if (!existsSync(pdfPath)) pdfPath = '';
    }

    const to = payload.to || getDefaultRecipient();
    if (!to) return json(res, 400, { error: 'Nema recipient-a: postavi `accounting.eRacuniInbox` u libro-config.json' });
    const date = payload.date || '';
    const seqMatch = payload.xmlFile.match(/\.(\d{4})(\d{3})\.xml$/);
    const seq = seqMatch ? seqMatch[2] : '';

    const _bankCfg = getConfig().bank;
    const _bankLabel = _bankCfg.name ? `[${_bankCfg.name}]` : '[Banka]';
    const _account = _bankCfg.accountNumber ? `racuna ${_bankCfg.accountNumber} ` : '';
    const subject = `${_bankLabel} Izvod ${_account}za dan ${date || '(bez datuma)'} · seq ${seq}`;
    const bodyTxt = `U prilogu XML${pdfPath ? ' + PDF' : ''} bankovnog izvoda za ${date}.\n\n(libro auto-send)`;

    const escStr = s => String(s).replace(/"/g, '\\"').replace(/\\/g, '\\\\');
    const makeAttach = (p) => p ? `make new attachment with properties {file name:POSIX file "${escStr(p)}"} at after last paragraph` : '';
    const attachLines = [pdfPath, xmlPath].filter(Boolean).map(makeAttach).join('\n            ');

    const appleScript = `
      tell application "Mail"
        set newMsg to make new outgoing message with properties {subject:"${escStr(subject)}", content:"${escStr(bodyTxt)}\\n", visible:true}
        tell newMsg
          make new to recipient at end of to recipients with properties {address:"${escStr(to)}"}
          tell content
            ${attachLines}
          end tell
        end tell
        activate
      end tell`;

    const proc = spawn('osascript', ['-e', appleScript], { cwd: ROOT });
    let stderr = '';
    proc.stderr.on('data', c => stderr += c.toString());
    proc.on('close', async (code) => {
      if (code === 0) {
        json(res, 200, { success: true, composed: true, subject, attachments: [xmlPath, pdfPath].filter(Boolean) });
      } else {
        json(res, 500, { success: false, error: stderr || 'osascript exited ' + code });
      }
    });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

/**
 * Označi bank statement kao poslan (nakon što je user kliknuo Send u Mail.app-u).
 * Isto koristimo za bulk "already sent" dashboard akcije.
 * Payload: { xmlFile, pdfFile?, to?, note?, action? }
 */
/**
 * Provjeri Mail.app rules za bank statement auto-redirect (sender iz configa).
 * Vrati info: postoji li rule, enabled, recipients, conditions.
 */
async function handleCheckMailRule(req, res) {
  try {
    const bankSender = getConfig().bank.statementSenderEmail || '';
    if (!bankSender) return json(res, 400, { error: 'Nema bank.statementSenderEmail u libro-config.json' });
    // AppleScript koristi config sender + (ako postoji) domena (npr. "hpb.hr").
    const bankDomain = bankSender.includes('@') ? bankSender.split('@')[1] : '';
    const escAS = s => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `
      tell application "Mail"
        set output to ""
        try
          set rs to every rule
          repeat with r in rs
            try
              set condList to every rule condition of r
              set hasHpb to false
              repeat with c in condList
                try
                  set ex to expression of c
                  if ex contains "${escAS(bankSender)}"${bankDomain ? ' or ex contains "' + escAS(bankDomain) + '"' : ''} then set hasHpb to true
                end try
              end repeat
              if hasHpb then
                set output to output & "RULE|" & (name of r) & "|"
                set output to output & "enabled=" & (enabled of r) & "|"
                try
                  set fwd to forward message of r
                  if fwd is not missing value and fwd is not "" then set output to output & "forward=" & fwd & "|"
                end try
                try
                  set rdr to redirect message of r
                  if rdr is not missing value and rdr is not "" then set output to output & "redirect=" & rdr & "|"
                end try
                set output to output & linefeed
              end if
            end try
          end repeat
        end try
        return output
      end tell`;
    const proc = spawn('osascript', ['-e', script]);
    let out = '', err = '';
    proc.stdout.on('data', c => out += c.toString());
    proc.stderr.on('data', c => err += c.toString());
    proc.on('close', code => {
      if (code !== 0) return json(res, 500, { error: err || 'osascript ' + code });
      const lines = out.trim().split('\n').filter(Boolean);
      const rules = lines.map(line => {
        const parts = line.split('|');
        const r = { name: parts[1] || '' };
        parts.slice(2).forEach(p => {
          const eq = p.indexOf('=');
          if (eq > 0) {
            const k = p.substring(0, eq);
            const v = p.substring(eq + 1);
            if (k === 'enabled') r.enabled = (v === 'true');
            else r[k] = v;
          }
        });
        return r;
      }).filter(r => r.name);
      const active = rules.find(r => r.enabled && (r.forward || r.redirect));
      return json(res, 200, {
        success: true,
        hasMailAppRule: !!active,
        rules: rules,
        activeRule: active || null,
      });
    });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

async function handleMarkStatementEmailSent(req, res) {
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body.toString('utf8'));
    if (!payload.xmlFile) return json(res, 400, { error: 'Missing xmlFile' });

    let sent = {};
    try { sent = JSON.parse(await readFile(BANK_EMAILS_SENT_FILE, 'utf8')); } catch (_) {}

    const stamp = {
      at: new Date().toISOString(),
      to: payload.to || getDefaultRecipient() || '',
      method: payload.method || 'manual',
      note: payload.note || '',
    };
    if (payload.action === 'unmark') {
      delete sent[payload.xmlFile];
      if (payload.pdfFile) delete sent[payload.pdfFile];
    } else {
      sent[payload.xmlFile] = stamp;
      if (payload.pdfFile) sent[payload.pdfFile] = stamp;
    }
    await writeFile(BANK_EMAILS_SENT_FILE, JSON.stringify(sent, null, 2));
    spawn(process.execPath, ['local-libro.mjs'], { cwd: ROOT, stdio: 'ignore', detached: true }).unref();
    return json(res, 200, { success: true });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════
// CLAUDE API — chat + PDF parse + cost tracking
// ═══════════════════════════════════════════════════════════

// Pricing (USD per 1M tokens) — manually updated kad se cijene promijene
// Source: https://docs.anthropic.com/en/docs/about-claude/models
const CLAUDE_PRICING = {
  'claude-sonnet-4-5':   { input: 3,  output: 15, cache_write: 3.75, cache_read: 0.30 },
  'claude-sonnet-4':     { input: 3,  output: 15, cache_write: 3.75, cache_read: 0.30 },
  'claude-haiku-4-5':    { input: 1,  output: 5,  cache_write: 1.25, cache_read: 0.10 },
  'claude-opus-4-5':     { input: 15, output: 75, cache_write: 18.75, cache_read: 1.50 },
  'claude-opus-4':       { input: 15, output: 75, cache_write: 18.75, cache_read: 1.50 },
};

function estimateClaudeCost(usage, model) {
  const p = CLAUDE_PRICING[model] || CLAUDE_PRICING['claude-sonnet-4-5'];
  const input = (usage.input_tokens || 0) / 1_000_000 * p.input;
  const output = (usage.output_tokens || 0) / 1_000_000 * p.output;
  const cacheWrite = (usage.cache_creation_input_tokens || 0) / 1_000_000 * p.cache_write;
  const cacheRead = (usage.cache_read_input_tokens || 0) / 1_000_000 * p.cache_read;
  return Math.round((input + output + cacheWrite + cacheRead) * 1_000_000) / 1_000_000;
}

async function recordClaudeUsage(operation, model, usage, costUsd) {
  let data = { total_usd: 0, by_day: {}, by_operation: {}, last_call: null };
  try {
    data = JSON.parse(await readFile(CLAUDE_USAGE_FILE, 'utf8'));
  } catch (_) { /* file doesn't exist yet */ }

  const today = new Date().toISOString().slice(0, 10);
  data.by_day[today] = (data.by_day[today] || 0) + costUsd;
  data.by_operation[operation] = (data.by_operation[operation] || 0) + costUsd;
  data.total_usd = (data.total_usd || 0) + costUsd;
  data.last_call = {
    at: new Date().toISOString(),
    operation, model, usage, cost_usd: costUsd,
  };
  await writeFile(CLAUDE_USAGE_FILE, JSON.stringify(data, null, 2));
  return data;
}

async function getDailyClaudeUsage() {
  try {
    const data = JSON.parse(await readFile(CLAUDE_USAGE_FILE, 'utf8'));
    const today = new Date().toISOString().slice(0, 10);
    return data.by_day[today] || 0;
  } catch (_) { return 0; }
}

async function callAnthropic(messages, opts = {}) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set in .env');
  }
  // Daily limit safety check
  const todayUsd = await getDailyClaudeUsage();
  if (todayUsd >= ANTHROPIC_DAILY_LIMIT_USD) {
    throw new Error('Daily Claude limit reached: $' + todayUsd.toFixed(4) + ' / $' + ANTHROPIC_DAILY_LIMIT_USD);
  }

  const model = opts.model || ANTHROPIC_MODEL;
  const body = {
    model: model,
    max_tokens: opts.max_tokens || 1024,
    messages: messages,
  };
  if (opts.system) body.system = opts.system;
  if (opts.tools) body.tools = opts.tools;
  if (opts.tool_choice) body.tool_choice = opts.tool_choice;

  const headers = {
    'x-api-key': ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  };
  // Enable extended caching beta (1h cache instead of 5min)
  // Not required, but cheaper if same prompt called more than 5min apart.

  const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(body),
  });

  if (!apiRes.ok) {
    const errBody = await apiRes.text();
    throw new Error(`Anthropic ${apiRes.status}: ${errBody.substring(0, 500)}`);
  }
  const result = await apiRes.json();
  const cost = estimateClaudeCost(result.usage || {}, model);
  if (opts.operation) {
    await recordClaudeUsage(opts.operation, model, result.usage, cost);
  }
  return { ...result, cost_usd: cost };
}

async function handleClaudeParsePdf(req, res) {
  try {
    const body = await readBody(req, 30 * 1024 * 1024);
    const payload = JSON.parse(body.toString('utf8'));

    let pdfBase64;
    if (payload.fileBase64) {
      pdfBase64 = payload.fileBase64;
    } else if (payload.path) {
      const fullPath = safeJoin(payload.path);
      if (!existsSync(fullPath)) return json(res, 404, { error: 'PDF not found' });
      pdfBase64 = (await readFile(fullPath)).toString('base64');
    } else {
      return json(res, 400, { error: 'Missing fileBase64 or path' });
    }

    const result = await callAnthropic([{
      role: 'user',
      content: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
        },
        {
          type: 'text',
          text: 'Procitaj ovaj racun (PDF) i extract-aj sljedece u JSON formatu. Odgovori SAMO JSON, bez komentara, bez markdown code blocks.\n\n' +
                '{\n' +
                '  "supplier": "naziv dobavljaca",\n' +
                '  "supplier_oib": "OIB ako vidis (samo brojevi) ili null",\n' +
                '  "amount": broj (samo broj, bez valute),\n' +
                '  "currency": "EUR" ili "USD" itd,\n' +
                '  "invoice_number": "broj racuna ili null",\n' +
                '  "issue_date": "YYYY-MM-DD ili null",\n' +
                '  "due_date": "YYYY-MM-DD ili null",\n' +
                '  "period": "YYYY-MM (mjesec za koji se racun odnosi) ili null",\n' +
                '  "vat_amount": broj ili null,\n' +
                '  "summary": "1 recenicu opis za sto je racun",\n' +
                '  "suggested_supplier_folder": "kratak folder name za supplier (bez specijalnih znakova, max 30 chars)"\n' +
                '}',
        },
      ],
    }], {
      max_tokens: 1024,
      operation: 'parse-pdf',
    });

    const textContent = (result.content || []).find(c => c.type === 'text')?.text || '';
    let parsed;
    try {
      const jsonMatch = textContent.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : textContent);
    } catch (e) {
      return json(res, 200, {
        success: false,
        error: 'Could not parse Claude response as JSON',
        raw: textContent,
        cost_usd: result.cost_usd,
      });
    }

    return json(res, 200, {
      success: true,
      parsed: parsed,
      usage: result.usage,
      cost_usd: result.cost_usd,
    });
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
}

// ───────────────────────────────────────────────────────────
// SAVED CLIENTS (libro-clients.json) — quick fill za izlazne
// ───────────────────────────────────────────────────────────
const CLIENTS_FILE = join(ROOT, 'libro-clients.json');

async function readClients() {
  try { return JSON.parse(await readFile(CLIENTS_FILE, 'utf8')); }
  catch (_) { return []; }
}

async function writeClients(items) {
  await writeFile(CLIENTS_FILE, JSON.stringify(items, null, 2), 'utf8');
}

function newClientId() {
  return 'cl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function normName(s) {
  return String(s || '').toLowerCase().replace(/[\.,'"&()]+/g, '').replace(/\s+/g, ' ').trim();
}

function normTaxId(s) {
  return String(s || '').replace(/[\s\-_./]+/g, '').toUpperCase().trim();
}

// Glavni ključ za save (upsert): preferiraj taxId, fallback na normalizirani name.
function clientKey(c) {
  const tid = normTaxId(c.taxId);
  if (tid) return 'tax:' + tid;
  return 'name:' + normName(c.name);
}

// Union-Find dedupe: dva klijenta su povezana ako dijele BILO koji od ova dva signala
// (isti taxId ili isti normName), čak i ako jedan signal nedostaje na jednoj strani.
function dedupeGroups(items) {
  const parent = items.map((_, i) => i);
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

  const taxBucket = new Map();
  const nameBucket = new Map();
  items.forEach((c, i) => {
    const tid = normTaxId(c.taxId);
    const nm = normName(c.name);
    if (tid) {
      if (taxBucket.has(tid)) union(i, taxBucket.get(tid));
      else taxBucket.set(tid, i);
    }
    if (nm) {
      if (nameBucket.has(nm)) union(i, nameBucket.get(nm));
      else nameBucket.set(nm, i);
    }
  });

  const groups = new Map();
  items.forEach((c, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(c);
  });
  return [...groups.values()];
}

async function handleClientsList(req, res) {
  const items = await readClients();
  return json(res, 200, { items });
}

async function handleClientsSave(req, res) {
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body.toString('utf8'));
    if (!payload.name || !String(payload.name).trim()) {
      return json(res, 400, { error: 'Naziv klijenta je obavezan' });
    }
    const items = await readClients();

    const incoming = {
      id: payload.id || newClientId(),
      name: String(payload.name).trim(),
      taxId: String(payload.taxId || '').trim(),
      address: String(payload.address || '').trim(),
      country: String(payload.country || '').trim(),
      currency: payload.currency || 'EUR',
      vatRate: payload.vatRate != null ? Number(payload.vatRate) : 0,
      vatBasis: payload.vatBasis || '',
      vatNote: payload.vatNote || '',
      defaultRecipient: payload.defaultRecipient || '',
      updatedAt: new Date().toISOString(),
    };

    let next, savedId, action;
    const byId = items.findIndex(c => c.id === incoming.id);
    if (byId >= 0) {
      next = items.slice();
      next[byId] = { ...items[byId], ...incoming };
      savedId = incoming.id;
      action = 'updated';
    } else {
      const key = clientKey(incoming);
      const byKey = items.findIndex(c => clientKey(c) === key);
      if (byKey >= 0) {
        // Već imamo klijent s istim ključem — update postojećeg, čuvamo originalni id/createdAt
        next = items.slice();
        next[byKey] = {
          ...items[byKey],
          ...incoming,
          id: items[byKey].id,
          createdAt: items[byKey].createdAt,
        };
        savedId = items[byKey].id;
        action = 'merged';
      } else {
        incoming.createdAt = new Date().toISOString();
        next = items.concat(incoming);
        savedId = incoming.id;
        action = 'created';
      }
    }
    await writeClients(next);
    return json(res, 200, { items: next, savedId, action });
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
}

async function handleClientsDelete(req, res) {
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body.toString('utf8'));
    if (!payload.id) return json(res, 400, { error: 'Missing id' });
    const items = await readClients();
    const next = items.filter(c => c.id !== payload.id);
    await writeClients(next);
    return json(res, 200, { items: next, removed: items.length - next.length });
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
}

/**
 * Pronađi duplikate (isti taxId ili isti normalizirani name).
 * Body: { apply: true|false }
 *   apply=false → preview: vraća { groups, wouldRemove }
 *   apply=true  → izvrši: zadrži najpotpuniji u svakoj grupi, ostale obriši
 */
async function handleClientsDedupe(req, res) {
  try {
    const body = await readBody(req);
    const payload = body.length ? JSON.parse(body.toString('utf8')) : {};
    const apply = !!payload.apply;

    const items = await readClients();
    const allGroups = dedupeGroups(items);

    const dupGroups = [];
    let wouldRemove = 0;
    const removeIds = new Set();
    for (const list of allGroups) {
      if (list.length < 2) continue;
      // Označi grupu po najjačem signalu — taxId ako postoji, inače naziv
      const tids = list.map(c => normTaxId(c.taxId)).filter(Boolean);
      const key = tids.length ? 'tax:' + tids[0] : 'name:' + normName(list[0].name);
      // Sort: keep onaj s najviše popunjenih polja, tie-break: najnoviji updatedAt/createdAt
      const score = c => Object.values(c).filter(v => v != null && String(v).trim() !== '').length;
      const sorted = list.slice().sort((a, b) => {
        const sa = score(a), sb = score(b);
        if (sb !== sa) return sb - sa;
        const ta = new Date(a.updatedAt || a.createdAt || 0).getTime();
        const tb = new Date(b.updatedAt || b.createdAt || 0).getTime();
        return tb - ta;
      });
      const keep = sorted[0];
      const remove = sorted.slice(1);
      remove.forEach(c => removeIds.add(c.id));
      wouldRemove += remove.length;
      dupGroups.push({
        key,
        keep: { id: keep.id, name: keep.name, taxId: keep.taxId, country: keep.country },
        remove: remove.map(c => ({ id: c.id, name: c.name, taxId: c.taxId, country: c.country })),
      });
    }

    if (!apply) {
      return json(res, 200, { groups: dupGroups, wouldRemove, total: items.length });
    }

    const next = items.filter(c => !removeIds.has(c.id));
    await writeClients(next);
    return json(res, 200, {
      items: next,
      removed: items.length - next.length,
      groups: dupGroups,
    });
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
}

// ───────────────────────────────────────────────────────────
// PARSE OUTGOING PDF (Claude Vision) — auto-fill izlazne forme
// ───────────────────────────────────────────────────────────
async function handleClaudeParseOutgoingPdf(req, res) {
  try {
    const body = await readBody(req, 30 * 1024 * 1024);
    const payload = JSON.parse(body.toString('utf8'));

    let pdfBase64;
    if (payload.fileBase64) pdfBase64 = payload.fileBase64;
    else if (payload.path) {
      const fullPath = safeJoin(payload.path);
      if (!existsSync(fullPath)) return json(res, 404, { error: 'PDF not found' });
      pdfBase64 = (await readFile(fullPath)).toString('base64');
    } else {
      return json(res, 400, { error: 'Missing fileBase64 or path' });
    }

    const result = await callAnthropic([{
      role: 'user',
      content: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
        },
        (() => {
          const _s = getSupplier();
          const _supLine = [
            _s.name && `firma: ${_s.name}`,
            _s.oib && `OIB ${_s.oib}`,
            _s.iban && `IBAN ${_s.iban}`,
          ].filter(Boolean).join(', ');
          return {
            type: 'text',
            text: `Ovo je IZLAZNI racun (invoice) koji izdaje${_supLine ? ' ' + _supLine : ' korisnik'}. ` +
                'Izvuci podatke o KUPCU (buyer/customer) i ostala polja. Odgovori SAMO JSON, bez markdown code blocks, bez komentara.\n\n' +
                '{\n' +
                '  "invoice_number": "broj racuna ili null",\n' +
                '  "issue_date": "YYYY-MM-DD ili null",\n' +
                '  "due_date": "YYYY-MM-DD ili null",\n' +
                '  "currency": "EUR" / "USD" / itd,\n' +
                '  "customer_name": "puni naziv kupca",\n' +
                '  "customer_tax_id": "OIB / VAT / EIN ili null (zadrzi originalni format kao na racunu)",\n' +
                '  "customer_address": "ulica, grad, postanski broj (sve u jednom redu)",\n' +
                '  "customer_country": "Hrvatska / USA / United Kingdom / itd",\n' +
                '  "vat_rate": broj (0, 5, 13 ili 25),\n' +
                '  "vat_basis": "razlog izuzeca ako 0% PDV (npr. Clanak 17, st.1) ili null",\n' +
                '  "vat_note": "napomena o reverse-charge / VAT direktivi ili null",\n' +
                '  "items": [\n' +
                '    {"description": "opis stavke", "qty": broj, "unit": "kom/h/dan/mj", "unit_price": broj}\n' +
                '  ],\n' +
                '  "subtotal": broj (osnovica),\n' +
                '  "vat_amount": broj (PDV iznos),\n' +
                '  "total": broj (ukupno)\n' +
                '}',
          };
        })(),
      ],
    }], {
      max_tokens: 1500,
      operation: 'parse-outgoing-pdf',
    });

    const textContent = (result.content || []).find(c => c.type === 'text')?.text || '';
    let parsed;
    try {
      const jsonMatch = textContent.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : textContent);
    } catch (e) {
      return json(res, 200, {
        success: false,
        error: 'Could not parse Claude response as JSON',
        raw: textContent,
        cost_usd: result.cost_usd,
      });
    }

    return json(res, 200, {
      success: true,
      parsed,
      usage: result.usage,
      cost_usd: result.cost_usd,
    });
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
}

async function handleClaudeChat(req, res) {
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body.toString('utf8'));
    if (!payload.messages || !Array.isArray(payload.messages)) {
      return json(res, 400, { error: 'Missing messages array' });
    }


    // Učitaj libro podatke odmah za tool execution
    let liboData = null;
    try {
      liboData = JSON.parse(await readFile(join(ROOT, 'libro-data.json'), 'utf8'));
    } catch (_) {}

    const sentMap = await (async () => {
      try { return JSON.parse(await readFile(join(ROOT, 'libro-emails-sent.json'), 'utf8')); }
      catch (_) { return {}; }
    })();

    const summary = liboData?.summary || {};
    const summaryText = liboData
      ? 'Trenutno: ' + (summary.invoiceCount || 0) + ' racuna · ' + (summary.transactionCount || 0) + ' TX (matched=' + (summary.matched || 0) + ', missing=' + (summary.missing || 0) + ') · racuni poslani knj.: ' + (summary.invoicesEmailSent || 0) + '/' + (summary.invoiceCount || 0)
      : 'libro-data.json not available';

    const _cfg = getConfig();
    const _sup = _cfg.supplier;
    const _supLine = [
      _sup.name && `firma: ${_sup.name}`,
      _sup.oib && `OIB ${_sup.oib}`,
      _sup.iban && `IBAN ${_sup.iban}`,
      _cfg.bank.name && `banka: ${_cfg.bank.name}`,
    ].filter(Boolean).join(', ');
    const _accLine = _cfg.accounting.enabled
      ? `- Knjigovodstvo: ${_cfg.accounting.primaryEmail || '(nije postavljeno)'}.${_cfg.accounting.eRacuniInbox ? ' E-racuni inbox: ' + _cfg.accounting.eRacuniInbox + '.' : ''}\n`
      : '';
    const _curr = _cfg.ui.currency || 'EUR';

    const systemPrompt = [
      {
        type: 'text',
        text: `Ti si AI asistent za libro — osobno racunovodstvo${_supLine ? ' (' + _supLine + ')' : ''}.\n\n` +
              'PRAVILA:\n' +
              `- Odgovori uvijek na ${_cfg.ui.locale === 'hr' ? 'hrvatskom (krnji, sleng OK)' : (_cfg.ui.locale || 'jeziku korisnika')}.\n` +
              `- Datumi u dd.mm.yy formatu. Iznosi: lokalna decimala (npr. 43,89 ${_curr === 'EUR' ? '€' : _curr}).\n` +
              '- Kratko i konkretno, bez "I will now" uvoda.\n' +
              _accLine +
              '\n' +
              'KRITICNO — koristenje tool-a:\n' +
              '- Kad user pita o KONKRETNOM racunu/TX-u (po dobavljacu, iznosu, datumu), OBAVEZNO koristi tools (search_invoices, search_transactions) da ti vratim STVARNE podatke iz libro-data.json. NE pretpostavi i ne halucinacij detalje.\n' +
              '- Tek nakon tool poziva odgovori user-u s informacijama iz tool rezultata.\n\n' +
              summaryText,
        cache_control: { type: 'ephemeral' },
      },
    ];

    const tools = [
      {
        name: 'search_invoices',
        description: 'Pretrazi lokalne PDF racune po dobavljacu, filename-u, periodu, ili emailSent statusu. Vrati listu match-eva s svim metadatom.',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Tekst za pretragu (matchira supplier, filename, path)' },
            period: { type: 'string', description: 'YYYY-MM (opcijski)' },
            emailSentOnly: { type: 'boolean', description: 'Vrati samo poslane (true) ili neposlane (false). Izostavi za sve.' },
            limit: { type: 'number', description: 'Max rezultata, default 10' },
          },
          required: ['query'],
        },
      },
      {
        name: 'search_transactions',
        description: 'Pretrazi bankovne TX-ove po counterparty, opisu, iznosu, ili statusu (MATCHED/MISSING/FORWARDED/IGNORED).',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Tekst za pretragu (counterparty, merchant, opis)' },
            status: { type: 'string', description: 'MATCHED | MISSING | FORWARDED | IGNORED | INCOMING (opcijski)' },
            amountMin: { type: 'number' },
            amountMax: { type: 'number' },
            dateFrom: { type: 'string', description: 'YYYY-MM-DD' },
            dateTo: { type: 'string', description: 'YYYY-MM-DD' },
            limit: { type: 'number' },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_invoice_status',
        description: 'Detaljan status jednog racuna (po path-u). Vraca: invoiceDate, emailSent (s datumom), supplier, file size, matched-TX-ovi.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path npr. "Invoice 2026/Placanje Apr 26/Apple/file.pdf"' },
          },
          required: ['path'],
        },
      },
    ];

    function execTool(name, input) {
      const invoices = liboData?.invoices || [];
      const transactions = liboData?.transactions || [];
      if (name === 'search_invoices') {
        const q = (input.query || '').toLowerCase();
        let results = invoices.filter(i => {
          const hay = (i.supplier + ' ' + i.filename + ' ' + i.path).toLowerCase();
          return hay.includes(q);
        });
        if (input.period) results = results.filter(i => (i.period || '').startsWith(input.period));
        if (input.emailSentOnly === true) results = results.filter(i => i.emailSent);
        if (input.emailSentOnly === false) results = results.filter(i => !i.emailSent);
        return results.slice(0, input.limit || 10).map(i => ({
          path: i.path, supplier: i.supplier, filename: i.filename, period: i.period,
          invoiceDate: i.invoiceDate, modifiedAt: i.modifiedAt,
          emailSent: !!i.emailSent, emailSentAt: i.emailSentAt || null, emailSentTo: i.emailSentTo || null,
          sizeBytes: i.sizeBytes,
        }));
      }
      if (name === 'search_transactions') {
        const q = (input.query || '').toLowerCase();
        let results = transactions.filter(t => {
          const hay = ((t.counterparty || '') + ' ' + (t.merchant || '') + ' ' + (t.description || '') + ' ' + (t.displayName || '')).toLowerCase();
          return hay.includes(q);
        });
        if (input.status) results = results.filter(t => t.status === input.status);
        if (input.amountMin != null) results = results.filter(t => Number(t.amount) >= input.amountMin);
        if (input.amountMax != null) results = results.filter(t => Number(t.amount) <= input.amountMax);
        if (input.dateFrom) results = results.filter(t => (t.bookDate || '') >= input.dateFrom);
        if (input.dateTo) results = results.filter(t => (t.bookDate || '') <= input.dateTo);
        return results.slice(0, input.limit || 10).map(t => ({
          ref: t.ref, bookDate: t.bookDate, amount: t.amount, currency: t.currency,
          counterparty: t.counterparty, merchant: t.merchant, description: (t.description || '').slice(0, 80),
          status: t.status, direction: t.direction,
          matchedInvoice: t.matchedInvoice ? { path: t.matchedInvoice.path, supplier: t.matchedInvoice.supplier } : null,
          stmtFile: t.stmtFile,
        }));
      }
      if (name === 'get_invoice_status') {
        const inv = invoices.find(i => i.path === input.path);
        if (!inv) return { error: 'Invoice not found: ' + input.path };
        const matchedTxs = transactions.filter(t => t.matchedInvoice?.path === input.path).map(t => ({
          ref: t.ref, bookDate: t.bookDate, amount: t.amount, counterparty: t.counterparty, status: t.status,
        }));
        return { ...inv, emailSentDetails: sentMap[inv.path] || null, matchedTransactions: matchedTxs };
      }
      return { error: 'Unknown tool: ' + name };
    }

    // Multi-turn loop dok Claude ne završi (stop_reason !== 'tool_use')
    const messages = payload.messages.slice();
    let totalCost = 0;
    let totalUsage = { input_tokens: 0, output_tokens: 0 };
    let finalText = '';

    for (let turn = 0; turn < 5; turn++) {
      const result = await callAnthropic(messages, {
        system: systemPrompt,
        max_tokens: 2048,
        operation: 'chat',
        tools,
      });
      totalCost += result.cost_usd || 0;
      const u = result.usage || {};
      totalUsage.input_tokens += u.input_tokens || 0;
      totalUsage.output_tokens += u.output_tokens || 0;

      const content = result.content || [];
      const textBlock = content.find(c => c.type === 'text');
      if (textBlock) finalText = textBlock.text || finalText;

      const toolUses = content.filter(c => c.type === 'tool_use');
      if (toolUses.length === 0 || result.stop_reason !== 'tool_use') {
        break;
      }

      // Append assistant message + execute tools
      messages.push({ role: 'assistant', content });
      const toolResults = toolUses.map(tu => ({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(execTool(tu.name, tu.input || {})),
      }));
      messages.push({ role: 'user', content: toolResults });
    }

    return json(res, 200, {
      success: true,
      message: finalText,
      usage: totalUsage,
      cost_usd: totalCost,
    });
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
}

/**
 * AI matching: za sve trenutno MISSING TX-ove, pita Claude da odluci koji
 * postojeci PDF (ako ijedan) im odgovara. Sprema u libro-tx-overrides.json
 * kao force-match (matching engine ih onda prikaze kao MATCHED s aiMatched=true).
 *
 * Common context (suppliers s razlicitim brand vs legal nazivima): AI mora
 * spojiti TX (counterparty = "LEGAL NAME D.O.O.") s računom čiji folder ima
 * brand naziv ("Tesla", "Apple", ...). System prompt instruira da koristi
 * kontekst iz invoice folder names.
 */
async function handleAiMatchMissing(req, res) {
  try {
    if (!ANTHROPIC_API_KEY) {
      return json(res, 400, { error: 'ANTHROPIC_API_KEY nije postavljen u .env' });
    }

    // Procitaj trenutni libro-data.json
    const dataRaw = await readFile(join(ROOT, 'libro-data.json'), 'utf8');
    const data = JSON.parse(dataRaw);
    const allTx = data.transactions || [];
    const allInv = data.invoices || [];

    // Skupi missing TX-ove (status MISSING, smjer OUT, ima ref)
    const missingTx = allTx.filter(t => t.status === 'MISSING' && t.direction === 'OUT' && t.ref);
    if (missingTx.length === 0) {
      return json(res, 200, {
        success: true,
        message: 'Nema missing TX-ova — sve je već matched.',
        suggestionsApplied: 0,
      });
    }

    // Procitaj postojece overrides (da ne re-rad-imo iste)
    const overridesPath = join(ROOT, 'libro-tx-overrides.json');
    let overrides = {};
    try {
      overrides = JSON.parse(await readFile(overridesPath, 'utf8'));
    } catch (_) {}

    // Filter: samo TX-ovi koji nemaju override
    const newMissing = missingTx.filter(t => !overrides[t.ref]);
    if (newMissing.length === 0) {
      return json(res, 200, {
        success: true,
        message: 'Svi missing TX-ovi vec imaju AI suggestion (libro-tx-overrides.json)',
        suggestionsApplied: 0,
      });
    }

    // Pripremi compact format za Claude (svaki TX kao 1 linija, svaki PDF kao 1 linija)
    const txList = newMissing.map((t, i) => ({
      idx: i,
      ref: t.ref,
      counterparty: t.counterparty || '',
      merchant: t.merchant || '',
      description: (t.description || '').slice(0, 120),
      amount: t.amount,
      currency: t.currency,
      date: t.bookDate,
    }));

    // PDF-ove: ne saljemo cijeli sadrzaj, samo metadata (path, supplier, filename, period)
    // Limit: ako je >150 PDF-ova, mogli bismo prelazit context. Trenutno ~200 = OK.
    const invList = allInv.map((inv, i) => ({
      idx: i,
      path: inv.path,
      supplier: inv.supplier,
      filename: inv.filename,
      period: inv.period,
    }));

    const systemPrompt = [
      'Ti pomazes spojiti hrvatske bankovne transakcije s PDF racunima za knjigovodstvo.',
      '',
      'Vazno o supplier mapping-u (brand vs legal name):',
      '- Counterparty u izvodu je LEGAL NAME (npr. "ACME D.O.O."), ali invoice folder je brand ("Acme").',
      '- Koristi kontekst iz folder strukture (Invoice {year}/Placanje MMM YY/<brand>/) za matching.',
      '- Curve transakcije (CRV*) imaju merchant info: e.g. "CRV*Linkedin" → match LinkedIn invoice.',
      '- Bankovne provizije / kartični fee-evi ne trebaju invoice (banka ih ne šalje računom).',
      '',
      'Zadatak: za svaku missing transakciju, predloziti najbolji PDF (ako postoji) iz dostupne liste.',
      'Match na osnovu: counterparty, merchant, opisa, iznosa, datuma, perioda PDF-a.',
      '',
      'Vrati STRIKTNO JSON niz objekata, bez ikakvog teksta okolo, bez markdown:',
      '[{"tx_idx": 0, "match_inv_idx": 5, "confidence": 0.85, "reason": "kratki razlog"}, ...]',
      '',
      'Pravila:',
      '- match_inv_idx mora biti broj iz dostupne liste invoice-a, ili null ako nema dobrog match-a.',
      '- confidence: 0-1 (0.9+ = sigurno, 0.7-0.9 = vjerojatno, ispod 0.7 = ne preporuca se mark)',
      '- reason: 1-2 hrvatske recenice zasto.',
      '- Ako nema dobrog match-a (HPB karticna naknada, porez, itd.), match_inv_idx = null',
      '- Ne izmisljaj invoice koji nije u listi.',
      '- Datum invoice perioda treba biti +/- 1 mjesec od TX datuma.',
    ].join('\n');

    const userMsg = [
      'MISSING TRANSACTIONS:',
      '```json',
      JSON.stringify(txList, null, 2),
      '```',
      '',
      'AVAILABLE PDF INVOICES:',
      '```json',
      JSON.stringify(invList, null, 2),
      '```',
      '',
      'Vrati JSON niz match suggestions (samo niz, bez okolnog teksta).',
    ].join('\n');

    console.log('  ▸ AI match: ' + newMissing.length + ' missing TX vs ' + allInv.length + ' invoice-a');

    const result = await callAnthropic(
      [{ role: 'user', content: userMsg }],
      {
        system: systemPrompt,
        max_tokens: 4096,
        operation: 'ai-match-missing',
      }
    );

    const txt = (result.content || []).find(c => c.type === 'text')?.text || '';
    // Pokusaj izvuci JSON niz (Claude moze imati markdown wrapping)
    let jsonStr = txt.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();
    const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
    if (arrayMatch) jsonStr = arrayMatch[0];

    let suggestions;
    try {
      suggestions = JSON.parse(jsonStr);
    } catch (e) {
      console.error('AI returned non-JSON:', txt.slice(0, 500));
      return json(res, 500, { error: 'AI vratio nevalidan JSON: ' + e.message, raw: txt.slice(0, 1000) });
    }

    // Apply suggestions: confidence >= 0.7 → save u overrides
    const MIN_CONFIDENCE = 0.7;
    const applied = [];
    const skipped = [];
    for (const s of suggestions) {
      const tx = txList[s.tx_idx];
      if (!tx) continue;
      if (s.match_inv_idx === null || s.match_inv_idx === undefined) {
        skipped.push({ ref: tx.ref, reason: s.reason || 'no match', confidence: s.confidence });
        continue;
      }
      const inv = invList[s.match_inv_idx];
      if (!inv) continue;
      if ((s.confidence || 0) < MIN_CONFIDENCE) {
        skipped.push({ ref: tx.ref, reason: 'low confidence: ' + (s.confidence || 0), suggested: inv.path });
        continue;
      }

      overrides[tx.ref] = {
        matchedInvoicePath: inv.path,
        matchedAt: new Date().toISOString(),
        method: 'ai-suggested',
        confidence: s.confidence,
        reason: s.reason || '',
        txCounterparty: tx.counterparty,
        invSupplier: inv.supplier,
      };
      applied.push({
        ref: tx.ref,
        counterparty: tx.counterparty,
        invoicePath: inv.path,
        confidence: s.confidence,
        reason: s.reason,
      });
    }

    await writeFile(overridesPath, JSON.stringify(overrides, null, 2));

    // Trigger rebuild
    spawn(process.execPath, ['local-libro.mjs'], { cwd: ROOT, stdio: 'ignore', detached: true }).unref();

    return json(res, 200, {
      success: true,
      missingFound: newMissing.length,
      suggestionsApplied: applied.length,
      suggestionsSkipped: skipped.length,
      applied: applied.slice(0, 50),
      skipped: skipped.slice(0, 50),
      cost_usd: result.cost_usd,
      tokensUsed: result.usage,
    });
  } catch (err) {
    console.error('ai-match-missing ERR:', err);
    json(res, 500, { error: err.message });
  }
}

/**
 * Reminders — jednostavna lista podsjetnika sa CRUD-om.
 * Storage: libro-reminders.json
 */
async function handleRemindersList(req, res) {
  try {
    const f = join(ROOT, 'libro-reminders.json');
    let items = [];
    try { items = JSON.parse(await readFile(f, 'utf8')); } catch (_) {}
    return json(res, 200, { success: true, items });
  } catch (err) { json(res, 500, { error: err.message }); }
}

async function handleRemindersSave(req, res) {
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body.toString('utf8'));
    const f = join(ROOT, 'libro-reminders.json');
    let items = [];
    try { items = JSON.parse(await readFile(f, 'utf8')); } catch (_) {}

    if (payload.action === 'add') {
      items.push({
        id: 'rm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        text: payload.text || '',
        priority: payload.priority || 'normal', // 'high' | 'normal' | 'low'
        dueDate: payload.dueDate || '',
        done: false,
        createdAt: new Date().toISOString(),
      });
    } else if (payload.action === 'toggle') {
      const it = items.find(x => x.id === payload.id);
      if (it) {
        it.done = !it.done;
        it.completedAt = it.done ? new Date().toISOString() : null;
      }
    } else if (payload.action === 'delete') {
      items = items.filter(x => x.id !== payload.id);
    } else if (payload.action === 'edit') {
      const it = items.find(x => x.id === payload.id);
      if (it) {
        if (payload.text !== undefined) it.text = payload.text;
        if (payload.priority !== undefined) it.priority = payload.priority;
        if (payload.dueDate !== undefined) it.dueDate = payload.dueDate;
        it.editedAt = new Date().toISOString();
      }
    }
    await writeFile(f, JSON.stringify(items, null, 2));
    return json(res, 200, { success: true, items });
  } catch (err) { json(res, 500, { error: err.message }); }
}

/**
 * Lista dokumenata u "Knjigovodstvo dokumenti/" folderu (ugovori, rjesenja, potvrde itd.)
 * Vraca: filename, size, mtime, mimeType, relativePath, opcijski meta (kategorija, napomena)
 */
async function handleAccountantDocsList(req, res) {
  try {
    const { readdir } = await import('fs/promises');
    const dir = accountantDocsDir();
    if (!existsSync(dir)) {
      return json(res, 200, { success: true, items: [] });
    }
    const metaFile = join(ROOT, 'libro-accountant-docs-meta.json');
    let meta = {};
    try { meta = JSON.parse(await readFile(metaFile, 'utf8')); } catch (_) {}

    const items = [];
    async function walk(d) {
      for (const e of await readdir(d, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const full = join(d, e.name);
        if (e.isDirectory()) {
          await walk(full);
        } else if (e.isFile()) {
          const s = statSync(full);
          const relPath = full.replace(ROOT + '/', '');
          const ext = e.name.split('.').pop().toLowerCase();
          const mimeType = (
            ext === 'pdf' ? 'application/pdf' :
            ext === 'xml' ? 'application/xml' :
            ext === 'docx' || ext === 'doc' ? 'application/msword' :
            ext === 'xlsx' || ext === 'xls' ? 'application/vnd.ms-excel' :
            ext === 'csv' ? 'text/csv' :
            ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
            ext === 'png' ? 'image/png' : 'application/octet-stream'
          );
          const m = meta[relPath] || {};
          items.push({
            filename: e.name,
            path: relPath,
            sizeBytes: s.size,
            modifiedAt: s.mtime.toISOString(),
            mimeType,
            ext,
            category: m.category || '',
            notes: m.notes || '',
            uploadedAt: m.uploadedAt || s.mtime.toISOString(),
          });
        }
      }
    }
    await walk(dir);
    items.sort((a, b) => (b.uploadedAt || '').localeCompare(a.uploadedAt || ''));
    return json(res, 200, { success: true, items });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

/**
 * Upload dokumenta u "Knjigovodstvo dokumenti/" folder.
 * Payload: { fileName, fileBase64, category?, notes? }
 */
async function handleAccountantDocsUpload(req, res) {
  try {
    const body = await readBody(req, 30 * 1024 * 1024);
    const payload = JSON.parse(body.toString('utf8'));
    if (!payload.fileBase64 || !payload.fileName) return json(res, 400, { error: 'Missing fileBase64 or fileName' });

    const targetDir = accountantDocsDir();
    await mkdir(targetDir, { recursive: true });
    const safeName = payload.fileName.replace(/[\/\\:*?"<>|]/g, '_');
    let destPath = join(targetDir, safeName);

    // Ako postoji, dodaj suffix s datumom
    if (existsSync(destPath)) {
      const ext = safeName.match(/\.[^.]+$/)?.[0] || '';
      const stem = ext ? safeName.slice(0, -ext.length) : safeName;
      const suffix = '_' + new Date().toISOString().slice(0, 10);
      destPath = join(targetDir, stem + suffix + ext);
    }

    const bytes = Buffer.from(payload.fileBase64, 'base64');
    await writeFile(destPath, bytes);
    const relPath = destPath.replace(ROOT + '/', '');

    if (payload.category || payload.notes) {
      const metaFile = join(ROOT, 'libro-accountant-docs-meta.json');
      let meta = {};
      try { meta = JSON.parse(await readFile(metaFile, 'utf8')); } catch (_) {}
      meta[relPath] = {
        category: payload.category || '',
        notes: payload.notes || '',
        uploadedAt: new Date().toISOString(),
      };
      await writeFile(metaFile, JSON.stringify(meta, null, 2));
    }

    return json(res, 200, { success: true, path: relPath, sizeBytes: bytes.length });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

/**
 * Vraca stvarne size + file count statistike za sve godišnje foldere.
 */
async function handleStorageStats(req, res) {
  try {
    const { readdir } = await import('fs/promises');
    const url2 = new URL(req.url || '', 'http://x');
    const year = url2.searchParams.get('year') || String(new Date().getFullYear());

    const dirs = [
      invoiceDir(year),
      bankDir(year),
      outgoingDir(year),
      accountantDocsDir(),
    ];

    let totalBytes = 0;
    let totalFiles = 0;
    let oldestMtime = Date.now();
    let newestMtime = 0;

    async function walk(dir) {
      if (!existsSync(dir)) return;
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          await walk(full);
        } else if (e.isFile()) {
          const s = statSync(full);
          totalBytes += s.size;
          totalFiles++;
          const mt = s.mtime.getTime();
          if (mt < oldestMtime) oldestMtime = mt;
          if (mt > newestMtime) newestMtime = mt;
        }
      }
    }

    for (const d of dirs) await walk(d);

    const sizeGB = totalBytes / (1024 * 1024 * 1024);
    const sizeMB = totalBytes / (1024 * 1024);
    const sizeStr = sizeGB >= 0.1 ? sizeGB.toFixed(2) + ' GB' : sizeMB.toFixed(0) + ' MB';

    let monthsSpan = 0;
    if (totalFiles > 0) {
      monthsSpan = Math.max(1, Math.round((newestMtime - oldestMtime) / (1000 * 60 * 60 * 24 * 30)));
    }

    return json(res, 200, {
      success: true,
      year,
      totalBytes,
      totalFiles,
      sizeStr,
      sizeGB: Number(sizeGB.toFixed(2)),
      sizeMB: Number(sizeMB.toFixed(0)),
      monthsSpan,
    });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

/**
 * Skenira lokalne foldere "Izlazni racuni YYYY/" za stare izlazne PDF-ove.
 * Vraca listu s parsiranim metadata-om (broj, kupac, datum) iz filename-a.
 */
async function handleOutgoingOldList(req, res) {
  try {
    const { readdir } = await import('fs/promises');
    const items = [];

    // Filter po godini (default trenutna)
    const url2 = new URL(req.url || '', 'http://x');
    const filterYear = url2.searchParams.get('year') || String(new Date().getFullYear());

    // Skenira folder za izlazne racune (config-driven)
    const targetDir = outgoingDir(filterYear);
    if (!existsSync(targetDir)) {
      return json(res, 200, { success: true, items: [], year: filterYear });
    }

    // Učitaj postojeću metadata
    const metaFile = join(ROOT, 'libro-outgoing-old.json');
    let meta = {};
    try { meta = JSON.parse(await readFile(metaFile, 'utf8')); } catch (_) {}

    function cleanCustomer(s) {
      if (!s) return '';
      // Ukloni "(1)", "(2)" itd. + RAČUN/E_RAČUN suffix
      return s.replace(/\s*\(\d+\)\s*$/g, '')
              .replace(/\s*[-–]\s*(E_)?RA[CČ]UN\s*$/i, '')
              .trim();
    }

    async function walk(dir) {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          await walk(full);
        } else if (e.isFile() && e.name.toLowerCase().endsWith('.pdf')) {
          const stats = statSync(full);
          const relPath = full.replace(ROOT + '/', '');
          // Parse filename: "20-1-1 - HERZOG KRAFT j.d.o.o. - E_RAČUN.pdf"
          const m = e.name.match(/^(\d+(?:-\d+)*)\s*[-–]\s*(.+?)\s*\.pdf$/i);
          let invoiceNumber = '', customer = '';
          if (m) {
            invoiceNumber = m[1].trim();
            customer = cleanCustomer(m[2]);
          } else {
            const m2 = e.name.match(/Invoice_No\s+(\S+)/i);
            if (m2) invoiceNumber = m2[1].replace(/\.pdf$/i,'');
            const m3 = e.name.match(/Racun_br\._(\S+?)\.pdf/i);
            if (m3) invoiceNumber = m3[1];
          }
          const override = meta[relPath] || {};
          items.push({
            path: relPath,
            filename: e.name,
            year: filterYear,
            sizeBytes: stats.size,
            modifiedAt: stats.mtime.toISOString(),
            invoiceNumber: override.invoiceNumber || invoiceNumber,
            customer: override.customer || customer,
            date: override.date || stats.mtime.toISOString().slice(0, 10),
            total: override.total != null ? override.total : null,
            currency: override.currency || 'EUR',
            country: override.country || '',
            notes: override.notes || '',
            aiParsed: !!override.aiParsedAt,
          });
        }
      }
    }

    await walk(targetDir);

    // Dedupe po invoice number (zadrzi onaj bez "(1)" u imenu, ili manji file)
    const byNum = new Map();
    for (const it of items) {
      if (!it.invoiceNumber) {
        byNum.set(it.path, it); // ako nema broja, drzi po path-u
        continue;
      }
      const existing = byNum.get(it.invoiceNumber);
      if (!existing) {
        byNum.set(it.invoiceNumber, it);
      } else {
        // Pravilo: original (bez "(N)") pobjeđuje
        const isCopy = /\(\d+\)/.test(it.filename);
        const existingIsCopy = /\(\d+\)/.test(existing.filename);
        if (existingIsCopy && !isCopy) byNum.set(it.invoiceNumber, it);
      }
    }
    const deduped = [...byNum.values()];
    deduped.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    return json(res, 200, { success: true, items: deduped, year: filterYear, duplicatesRemoved: items.length - deduped.length });
  } catch (err) {
    console.error('outgoing-old-list ERR:', err);
    json(res, 500, { error: err.message });
  }
}

/**
 * Upload prijašnjeg izlaznog računa.
 * Payload: { fileName, fileBase64, year, invoiceNumber, customer, date, total, currency, country, notes }
 */
async function handleOutgoingOldUpload(req, res) {
  try {
    const body = await readBody(req, 30 * 1024 * 1024);
    const payload = JSON.parse(body.toString('utf8'));
    if (!payload.fileBase64 || !payload.fileName) return json(res, 400, { error: 'Missing fileBase64 or fileName' });

    const year = String(payload.year || new Date().getFullYear());
    const targetDir = join(outgoingDir(year), '_uploaded_old');
    await mkdir(targetDir, { recursive: true });

    const safeName = payload.fileName.replace(/[\/\\:*?"<>|]/g, '_');
    const destPath = join(targetDir, safeName);
    const bytes = Buffer.from(payload.fileBase64, 'base64');
    await writeFile(destPath, bytes);

    // Save metadata
    const metaFile = join(ROOT, 'libro-outgoing-old.json');
    let meta = {};
    try { meta = JSON.parse(await readFile(metaFile, 'utf8')); } catch (_) {}
    const relPath = destPath.replace(ROOT + '/', '');
    meta[relPath] = {
      invoiceNumber: payload.invoiceNumber || '',
      customer: payload.customer || '',
      date: payload.date || '',
      total: payload.total || null,
      currency: payload.currency || 'EUR',
      country: payload.country || '',
      notes: payload.notes || '',
      uploadedAt: new Date().toISOString(),
    };
    await writeFile(metaFile, JSON.stringify(meta, null, 2));

    return json(res, 200, { success: true, path: relPath, sizeBytes: bytes.length });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

/**
 * AI parse jednog ili više starih izlaznih PDF-ova — Claude Vision izvuče
 * kupca, datum izdavanja, iznos, valutu.
 * Payload: { paths?: [...] } — ako prazno, parse-a sve koji nisu već parsani
 */
async function handleOutgoingOldAiParse(req, res) {
  try {
    if (!ANTHROPIC_API_KEY) return json(res, 400, { error: 'ANTHROPIC_API_KEY nije postavljen' });

    const body = await readBody(req, 4 * 1024 * 1024);
    const payload = body.length ? JSON.parse(body.toString('utf8')) : {};

    // Učitaj postojeću metadata
    const metaFile = join(ROOT, 'libro-outgoing-old.json');
    let meta = {};
    try { meta = JSON.parse(await readFile(metaFile, 'utf8')); } catch (_) {}

    let targetPaths = [];
    if (payload.paths && Array.isArray(payload.paths)) {
      targetPaths = payload.paths;
    } else {
      // Bulk: skeniraj outgoing folder za zadanu godinu, samo neparsirane
      const filterYear = payload.year || String(new Date().getFullYear());
      const dir = outgoingDir(filterYear);
      if (existsSync(dir)) {
        const { readdir } = await import('fs/promises');
        async function walk(d, list) {
          for (const e of await readdir(d, { withFileTypes: true })) {
            const full = join(d, e.name);
            if (e.isDirectory()) await walk(full, list);
            else if (e.name.toLowerCase().endsWith('.pdf')) list.push(full.replace(ROOT + '/', ''));
          }
        }
        const all = [];
        await walk(dir, all);
        targetPaths = all.filter(p => !meta[p] || !meta[p].aiParsedAt);
      }
    }

    const TARGET_LIMIT = Math.min(targetPaths.length, payload.limit || 30);
    if (TARGET_LIMIT === 0) {
      return json(res, 200, { success: true, parsed: 0, message: 'Nema PDF-ova za parse' });
    }

    const _supX = getSupplier();
    const systemPrompt = [
      `Ti pomazes parsirati IZLAZNE racune${_supX.name ? ' (' + _supX.name + ' prema klijentu)' : ''}.`,
      'Iz PDF-a izvuci:',
      '- customer: ime kupca / firme prema kojoj je racun izdan (bez naslova "RAČUN", bez OIB-a)',
      '- date: datum izdavanja (issue date), format YYYY-MM-DD',
      '- total: ukupan iznos (samo broj, npr. 2500.00)',
      '- currency: valuta (EUR, USD, HRK)',
      '- country: zemlja kupca (HR, GR, DE, IE, IT, LT itd.)',
      '',
      'Vrati STRIKTNO JSON, bez markdowna:',
      '{"customer":"HERZOG KRAFT j.d.o.o.","date":"2026-04-15","total":2500.00,"currency":"EUR","country":"HR"}',
      'Ako neki podatak ne mozes naci, vrati null za to polje.',
    ].join('\n');

    const parsed = [];
    const failed = [];

    for (let i = 0; i < TARGET_LIMIT; i++) {
      const relPath = targetPaths[i];
      const absPath = safeJoin(relPath);
      if (!existsSync(absPath)) { failed.push({ path: relPath, reason: 'not found' }); continue; }
      try {
        const pdfBytes = await readFile(absPath);
        const pdfBase64 = pdfBytes.toString('base64');
        const result = await callAnthropic(
          [{
            role: 'user',
            content: [
              { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
              { type: 'text', text: 'Parsiraj IZLAZNI racun. Vrati JSON.' },
            ],
          }],
          { system: systemPrompt, max_tokens: 400, operation: 'outgoing-old-parse' }
        );
        const txt = (result.content || []).find(c => c.type === 'text')?.text || '';
        let jsonStr = txt.trim();
        const fence = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fence) jsonStr = fence[1].trim();
        const objM = jsonStr.match(/\{[\s\S]*\}/);
        if (objM) jsonStr = objM[0];
        const data = JSON.parse(jsonStr);

        // Update meta
        meta[relPath] = {
          ...(meta[relPath] || {}),
          customer: data.customer || meta[relPath]?.customer || '',
          date: (data.date && /^\d{4}-\d{2}-\d{2}$/.test(data.date)) ? data.date : (meta[relPath]?.date || ''),
          total: (data.total != null) ? data.total : (meta[relPath]?.total),
          currency: data.currency || meta[relPath]?.currency || 'EUR',
          country: data.country || meta[relPath]?.country || '',
          aiParsedAt: new Date().toISOString(),
        };
        parsed.push({ path: relPath, ...data });
      } catch (e) {
        failed.push({ path: relPath, reason: e.message });
      }
    }

    await writeFile(metaFile, JSON.stringify(meta, null, 2));

    return json(res, 200, {
      success: true,
      parsed: parsed.length,
      failed: failed.length,
      remaining: targetPaths.length - TARGET_LIMIT,
      sample: parsed.slice(0, 5),
    });
  } catch (err) {
    console.error('outgoing-old-ai-parse ERR:', err);
    json(res, 500, { error: err.message });
  }
}

/**
 * Soft-delete izlazni racun — premjesti PDF/XML u arhivu (ne permanent delete).
 * Payload: { path }
 * Arhiva: _arhiva_obrisani_izlazni/<date>/<filename>
 */
async function handleOutgoingOldDelete(req, res) {
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body.toString('utf8'));
    if (!payload.path) return json(res, 400, { error: 'Missing path' });

    const fromAbs = safeJoin(payload.path);
    if (!existsSync(fromAbs)) return json(res, 404, { error: 'Fajl ne postoji' });

    const today = new Date().toISOString().slice(0, 10);
    const archiveBase = join(ROOT, '_arhiva_obrisani_izlazni', today);
    await mkdir(archiveBase, { recursive: true });

    // Premjesti PDF
    const filename = fromAbs.split('/').pop();
    const archivePdf = join(archiveBase, filename);
    const { rename } = await import('fs/promises');
    await rename(fromAbs, archivePdf);

    // Premjesti i XML ako postoji s istim stem-om
    const stem = fromAbs.replace(/\.(pdf|PDF)$/, '');
    const xmlPath = stem + '.xml';
    let archivedXml = null;
    if (existsSync(xmlPath)) {
      archivedXml = join(archiveBase, xmlPath.split('/').pop());
      await rename(xmlPath, archivedXml);
    }

    // Update metadata: oznaci deleted + arhiviranu lokaciju
    const metaFile = join(ROOT, 'libro-outgoing-old.json');
    let meta = {};
    try { meta = JSON.parse(await readFile(metaFile, 'utf8')); } catch (_) {}
    const archivedMeta = meta[payload.path] || {};
    archivedMeta.deletedAt = new Date().toISOString();
    archivedMeta.archivedPath = archivePdf.replace(ROOT + sep, '');
    if (archivedXml) archivedMeta.archivedXmlPath = archivedXml.replace(ROOT + sep, '');
    delete meta[payload.path];

    // Spremi u arhiva metadata file
    const arhivaMetaFile = join(ROOT, 'libro-outgoing-arhiva.json');
    let arhivaMeta = {};
    try { arhivaMeta = JSON.parse(await readFile(arhivaMetaFile, 'utf8')); } catch (_) {}
    const archivedRelPath = archivePdf.replace(ROOT + sep, '');
    arhivaMeta[archivedRelPath] = { ...archivedMeta, originalPath: payload.path };
    await writeFile(arhivaMetaFile, JSON.stringify(arhivaMeta, null, 2));
    await writeFile(metaFile, JSON.stringify(meta, null, 2));

    return json(res, 200, {
      success: true,
      archivedPath: archivedRelPath,
      archivedXmlPath: archivedXml ? archivedXml.replace(ROOT + sep, '') : null,
    });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

/**
 * Lista arhiviranih (soft-deleted) izlaznih racuna.
 */
async function handleOutgoingArhivaList(req, res) {
  try {
    const f = join(ROOT, 'libro-outgoing-arhiva.json');
    let meta = {};
    try { meta = JSON.parse(await readFile(f, 'utf8')); } catch (_) {}
    const items = Object.entries(meta).map(([archivedPath, m]) => ({
      archivedPath,
      ...m,
    }));
    items.sort((a, b) => (b.deletedAt || '').localeCompare(a.deletedAt || ''));
    return json(res, 200, { success: true, items });
  } catch (err) { json(res, 500, { error: err.message }); }
}

/**
 * Restore — vrati arhiviran izlazni racun nazad u Poslane.
 * Payload: { archivedPath }
 */
async function handleOutgoingArhivaRestore(req, res) {
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body.toString('utf8'));
    if (!payload.archivedPath) return json(res, 400, { error: 'Missing archivedPath' });

    const arhivaMetaFile = join(ROOT, 'libro-outgoing-arhiva.json');
    let arhivaMeta = {};
    try { arhivaMeta = JSON.parse(await readFile(arhivaMetaFile, 'utf8')); } catch (_) {}
    const m = arhivaMeta[payload.archivedPath];
    if (!m) return json(res, 404, { error: 'Nema arhiva metadata' });

    const fromAbs = safeJoin(payload.archivedPath);
    if (!existsSync(fromAbs)) return json(res, 404, { error: 'Arhivirani fajl ne postoji' });

    // Vrati na originalnu lokaciju
    const toAbs = safeJoin(m.originalPath);
    await mkdir(dirname(toAbs), { recursive: true });
    const { rename } = await import('fs/promises');
    await rename(fromAbs, toAbs);

    let restoredXml = null;
    if (m.archivedXmlPath && existsSync(safeJoin(m.archivedXmlPath))) {
      const xmlOrig = m.archivedXmlPath.replace(/.*?\/(?=[^\/]+$)/, '');
      const stem = m.originalPath.replace(/\.(pdf|PDF)$/, '');
      const restoreXmlPath = stem + '.xml';
      await rename(safeJoin(m.archivedXmlPath), safeJoin(restoreXmlPath));
      restoredXml = restoreXmlPath;
    }

    // Update meta
    const metaFile = join(ROOT, 'libro-outgoing-old.json');
    let meta = {};
    try { meta = JSON.parse(await readFile(metaFile, 'utf8')); } catch (_) {}
    const restoreMeta = { ...m };
    delete restoreMeta.deletedAt;
    delete restoreMeta.archivedPath;
    delete restoreMeta.archivedXmlPath;
    delete restoreMeta.originalPath;
    restoreMeta.restoredAt = new Date().toISOString();
    meta[m.originalPath] = restoreMeta;
    delete arhivaMeta[payload.archivedPath];

    await writeFile(metaFile, JSON.stringify(meta, null, 2));
    await writeFile(arhivaMetaFile, JSON.stringify(arhivaMeta, null, 2));

    return json(res, 200, { success: true, restoredPath: m.originalPath, restoredXml });
  } catch (err) { json(res, 500, { error: err.message }); }
}

/**
 * Manual edit metadata za stari izlazni racun.
 * Payload: { path, customer?, date?, total?, currency?, country?, notes?, invoiceNumber? }
 */
async function handleOutgoingOldEdit(req, res) {
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body.toString('utf8'));
    if (!payload.path) return json(res, 400, { error: 'Missing path' });

    const metaFile = join(ROOT, 'libro-outgoing-old.json');
    let meta = {};
    try { meta = JSON.parse(await readFile(metaFile, 'utf8')); } catch (_) {}

    const existing = meta[payload.path] || {};
    meta[payload.path] = {
      ...existing,
      ...(payload.invoiceNumber !== undefined ? { invoiceNumber: payload.invoiceNumber } : {}),
      ...(payload.customer !== undefined ? { customer: payload.customer } : {}),
      ...(payload.date !== undefined ? { date: payload.date } : {}),
      ...(payload.total !== undefined ? { total: payload.total } : {}),
      ...(payload.currency !== undefined ? { currency: payload.currency } : {}),
      ...(payload.country !== undefined ? { country: payload.country } : {}),
      ...(payload.notes !== undefined ? { notes: payload.notes } : {}),
      editedAt: new Date().toISOString(),
    };
    await writeFile(metaFile, JSON.stringify(meta, null, 2));
    return json(res, 200, { success: true, path: payload.path, meta: meta[payload.path] });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

/**
 * Lista emailova od knjigovođa s attachmentima.
 * Source: Gmail (accountant emails iz `accounting.primaryEmail` + `secondaryEmails`)
 * Cache: libro-accountant-emails.json (5 min TTL).
 */
async function handleAccountantEmails(req, res) {
  try {
    if (!GMAIL_REFRESH_TOKEN) {
      return json(res, 400, { error: 'Gmail OAuth nije postavljen — pokreni: node setup-gmail-auth.mjs' });
    }

    const cacheFile = join(ROOT, 'libro-accountant-emails.json');
    let cache = null;
    try {
      const raw = await readFile(cacheFile, 'utf8');
      cache = JSON.parse(raw);
    } catch (_) {}

    const url2 = new URL(req.url || '', 'http://x');
    const force = url2.searchParams.get('force') === '1';
    const incremental = url2.searchParams.get('incremental') === '1';

    // Cache se NIKAD ne expire-a automatski — samo eksplicitni refresh (force=1) ili
    // incrementalna sync (incremental=1) traže nove poruke
    if (!force && !incremental && cache && cache.threads) {
      return json(res, 200, { ...cache, cached: true });
    }

    const accounts = getActiveGmailAccounts();
    if (accounts.length === 0) {
      return json(res, 400, { error: 'Gmail OAuth nije postavljen' });
    }

    const senders = getAccountantEmails();
    if (senders.length === 0) {
      return json(res, 400, { error: 'Nijedan knjigovođa email nije postavljen u libro-config.json (accounting.primaryEmail/secondaryEmails). Uključi knjigovodstvo u setup wizardu ili Settings.' });
    }
    const baseQuery = senders.map(s => 'from:' + s).join(' OR ');

    // Cache po account-u
    const knownIdsByAccount = {};
    accounts.forEach(a => { knownIdsByAccount[a] = new Set(); });
    if (incremental && cache && cache.threads) {
      cache.threads.forEach(t => {
        const a = t.account || 'primary';
        if (!knownIdsByAccount[a]) knownIdsByAccount[a] = new Set();
        knownIdsByAccount[a].add(t.id);
      });
    }

    const threads = [];
    if (incremental && cache && cache.threads) threads.push(...cache.threads);

    for (const account of accounts) {
      let query = baseQuery;
      if (incremental) {
        const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '/');
        query = '(' + baseQuery + ') after:' + since;
      }
      const accessToken = await getGmailAccessToken(account);

      let pageToken = '';
      const accMessages = [];
      let pages = 0;
      do {
        const list = await gmailApi(
          `users/me/messages?q=${encodeURIComponent(query)}&maxResults=100${pageToken ? '&pageToken=' + pageToken : ''}`,
          accessToken
        );
        (list.messages || []).forEach(m => accMessages.push(m.id));
        pageToken = list.nextPageToken;
        pages++;
        if (pages > 5) break;
      } while (pageToken);

      const known = knownIdsByAccount[account] || new Set();
      const newMessages = incremental ? accMessages.filter(id => !known.has(id)) : accMessages;

      for (const msgId of newMessages) {
        // Skip ako vec imamo iz drugog account-a (cross-account dedupe po Message-ID header)
        const msg = await gmailApi(`users/me/messages/${msgId}?format=full`, accessToken);
        const headers = (msg.payload?.headers || []).reduce((h, x) => {
          h[x.name.toLowerCase()] = x.value;
          return h;
        }, {});
        const date = msg.internalDate ? new Date(parseInt(msg.internalDate, 10)).toISOString() : '';
        const messageIdHeader = headers['message-id'] || '';
        // Dedupe: preskočimo ako thread s istim Message-ID već postoji (drugi račun)
        if (messageIdHeader && threads.some(t => t.messageIdHeader === messageIdHeader)) continue;

        const attachments = [];
        function walk(p) {
          if (p.filename && p.body?.attachmentId) {
            attachments.push({
              filename: p.filename,
              attachmentId: p.body.attachmentId,
              size: p.body.size || 0,
              mimeType: p.mimeType || 'application/octet-stream',
            });
          }
          if (p.parts) p.parts.forEach(walk);
        }
        if (msg.payload) walk(msg.payload);

        threads.push({
          id: msgId,
          threadId: msg.threadId,
          date,
          from: headers.from || '',
          to: headers.to || '',
          subject: headers.subject || '(bez subjecta)',
          snippet: msg.snippet || '',
          attachments,
          labels: msg.labelIds || [],
          account, // 'primary' | 'secondary'
          messageIdHeader,
        });
      }
    }

    threads.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    const result = {
      success: true,
      fetchedAt: new Date().toISOString(),
      count: threads.length,
      threads,
    };

    await writeFile(cacheFile, JSON.stringify(result, null, 2));
    return json(res, 200, result);
  } catch (err) {
    console.error('accountant-emails ERR:', err);
    json(res, 500, { error: err.message });
  }
}

/**
 * Download attachment iz knjigovođinog emaila — vraca base64.
 * Payload: { messageId, attachmentId, filename }
 */
async function handleAccountantDownload(req, res) {
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body.toString('utf8'));
    if (!payload.messageId || !payload.attachmentId) return json(res, 400, { error: 'Missing messageId or attachmentId' });

    // Pokušaj prvo specificiran account, fallback na sve aktivne
    const accounts = payload.account ? [payload.account] : getActiveGmailAccounts();
    let att = null;
    let lastErr = null;
    for (const acc of accounts) {
      try {
        const accessToken = await getGmailAccessToken(acc);
        att = await gmailApi(
          `users/me/messages/${payload.messageId}/attachments/${payload.attachmentId}`,
          accessToken
        );
        if (att && att.data) break;
      } catch (e) { lastErr = e; }
    }
    if (!att || !att.data) return json(res, 404, { error: 'No attachment data' + (lastErr ? ': ' + lastErr.message : '') });

    // Save lokalno u Knjigovodstvo folder za brzi pregled
    const targetDir = accountantDocsDir();
    await mkdir(targetDir, { recursive: true });
    const safeFilename = (payload.filename || 'attachment').replace(/[\/\\:*?"<>|]/g, '_');
    const destPath = join(targetDir, safeFilename);

    const b64 = att.data.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Buffer.from(b64, 'base64');
    await writeFile(destPath, bytes);

    return json(res, 200, {
      success: true,
      filename: safeFilename,
      localPath: 'Knjigovodstvo dokumenti/' + safeFilename,
      sizeBytes: bytes.length,
    });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

/**
 * AI kategorizacija svih attachmenta od knjigovođa.
 * Šalje listu (filename + subject) Claude-u za kategorizaciju.
 */
async function handleAccountantAiCategorize(req, res) {
  try {
    if (!ANTHROPIC_API_KEY) return json(res, 400, { error: 'ANTHROPIC_API_KEY nije postavljen' });

    const cacheFile = join(ROOT, 'libro-accountant-emails.json');
    let cache;
    try { cache = JSON.parse(await readFile(cacheFile, 'utf8')); }
    catch (_) { return json(res, 400, { error: 'Nema cache-a — prvo /api/accountant/emails' }); }

    const items = [];
    (cache.threads || []).forEach(t => {
      (t.attachments || []).forEach(a => {
        items.push({
          msgId: t.id,
          attId: a.attachmentId,
          filename: a.filename,
          subject: t.subject,
          date: t.date.slice(0, 10),
          from: t.from.slice(0, 60),
        });
      });
    });

    if (items.length === 0) return json(res, 200, { success: true, categorized: 0, categories: {} });

    const systemPrompt = [
      'Ti pomazes razvrstati attachmente koje hrvatska knjigovotvina šalje klijentu.',
      'Za svaki attachment, predlozi kategoriju iz fiksnog seta:',
      '- "Bilanca" — bilance, izvjestaji o stanju',
      '- "IRA" — izlazni racuni od klijenta (output invoices)',
      '- "URA" — ulazni racuni dobavljaca (input invoices)',
      '- "JOPPD" — JOPPD obrasci (place, doprinosi)',
      '- "PDV" — PDV obrasci (PDV-O, PDV-V)',
      '- "Porez" — porezi (PD, PDF dohodak)',
      '- "Isplate" — isplatne liste, place',
      '- "Bankovni izvodi" — izvodi banke',
      '- "Ugovor" — ugovori, dodaci ugovora',
      '- "Obrazac" — opci obrasci, zahtjevi',
      '- "Izvjestaj" — financijski izvjestaji, GFI',
      '- "Dokumentacija" — opcа dokumentacija, scan-ovi',
      '- "Ostalo" — sve ostalo',
      '',
      'Ako filename i subject ne daju dovoljno info → "Ostalo".',
      'Vrati STRIKTNO JSON niz, bez markdowna:',
      '[{"idx": 0, "category": "Bilanca", "confidence": 0.9}, ...]',
    ].join('\n');

    const userMsg = 'Attachmenti za kategorizaciju:\n```json\n' + JSON.stringify(items.map((it, i) => ({
      idx: i,
      filename: it.filename,
      subject: it.subject,
      from: it.from,
      date: it.date,
    })), null, 2) + '\n```';

    const result = await callAnthropic(
      [{ role: 'user', content: userMsg }],
      { system: systemPrompt, max_tokens: 4096, operation: 'accountant-categorize' }
    );

    const txt = (result.content || []).find(c => c.type === 'text')?.text || '';
    let jsonStr = txt.trim();
    const fence = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) jsonStr = fence[1].trim();
    const arrM = jsonStr.match(/\[[\s\S]*\]/);
    if (arrM) jsonStr = arrM[0];

    const suggestions = JSON.parse(jsonStr);
    const categories = {};
    suggestions.forEach(s => {
      const it = items[s.idx];
      if (!it) return;
      const key = it.msgId + '/' + it.attId;
      categories[key] = {
        category: s.category || 'Ostalo',
        confidence: s.confidence || 0,
        filename: it.filename,
        subject: it.subject,
        date: it.date,
      };
    });

    const catFile = join(ROOT, 'libro-accountant-categories.json');
    await writeFile(catFile, JSON.stringify({ categorizedAt: new Date().toISOString(), categories }, null, 2));

    return json(res, 200, {
      success: true,
      categorized: Object.keys(categories).length,
      cost_usd: result.cost_usd,
      categories,
    });
  } catch (err) {
    console.error('accountant-ai-categorize ERR:', err);
    json(res, 500, { error: err.message });
  }
}

/**
 * Manualno postavi invoice date za neki PDF.
 * Payload: { path, date: "YYYY-MM-DD", source: "manual" | "today-fallback" }
 */
async function handleInvoiceDateSet(req, res) {
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body.toString('utf8'));
    if (!payload.path || !payload.date) return json(res, 400, { error: 'Missing path or date' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.date)) return json(res, 400, { error: 'Invalid date format (YYYY-MM-DD)' });

    const datesPath = join(ROOT, 'libro-invoice-dates.json');
    let dates = {};
    try { dates = JSON.parse(await readFile(datesPath, 'utf8')); } catch (_) {}

    dates[payload.path] = {
      date: payload.date,
      source: payload.source || 'manual',
      setAt: new Date().toISOString(),
    };
    await writeFile(datesPath, JSON.stringify(dates, null, 2));

    spawn(process.execPath, ['local-libro.mjs'], { cwd: ROOT, stdio: 'ignore', detached: true }).unref();
    return json(res, 200, { success: true, path: payload.path, date: payload.date });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

/**
 * AI extract invoice date iz PDF-a koristeci Claude Vision.
 * Payload (per file): { path }
 * Payload (bulk): { paths: [...] } ili nista (radi sve PDF-ove koji nemaju date)
 *
 * Sprema u libro-invoice-dates.json: { path: { date: "YYYY-MM-DD", extractedAt, source: 'ai' } }
 * local-libro.mjs zatim ucitava i pridruzuje `invoiceDate` polje invoice-u.
 */
async function handleClaudeExtractInvoiceDate(req, res) {
  try {
    if (!ANTHROPIC_API_KEY) {
      return json(res, 400, { error: 'ANTHROPIC_API_KEY nije postavljen u .env' });
    }

    const body = await readBody(req, 10 * 1024 * 1024);
    const payload = body.length ? JSON.parse(body.toString('utf8')) : {};

    const datesPath = join(ROOT, 'libro-invoice-dates.json');
    let dates = {};
    try {
      dates = JSON.parse(await readFile(datesPath, 'utf8'));
    } catch (_) {}

    let targetPaths = [];
    if (payload.path) {
      // Single PDF
      targetPaths = [payload.path];
    } else if (payload.paths && Array.isArray(payload.paths)) {
      targetPaths = payload.paths;
    } else {
      // Bulk: sve PDF-ove koji nemaju date u libro-data.json
      const dataRaw = await readFile(join(ROOT, 'libro-data.json'), 'utf8');
      const data = JSON.parse(dataRaw);
      targetPaths = (data.invoices || [])
        .filter(inv => !dates[inv.path] && inv.path.toLowerCase().endsWith('.pdf'))
        .map(inv => inv.path);
    }

    if (targetPaths.length === 0) {
      return json(res, 200, {
        success: true,
        message: 'Nema PDF-ova bez datuma — sve je vec extracted.',
        extractedCount: 0,
      });
    }

    console.log('  ▸ Extract dates: ' + targetPaths.length + ' PDF(s)');

    const systemPrompt = [
      'Ti si specijalist za citanje hrvatskih i engleskih racuna.',
      'Tvoj jedini zadatak: pronaci INVOICE DATE iz PDF-a (datum izdavanja racuna).',
      '',
      'Pravila:',
      '- Trazi labele: "Invoice Date", "Datum izdavanja", "Datum racuna", "Date", "INVOICE DATE", "Datum"',
      '- NE pomesat s "Due date", "Datum dospijeca", "Sequence date", "Renewal date"',
      '- Format: vraca ISO YYYY-MM-DD',
      '- Ako nije siguran u datum, vrati null',
      '',
      'Odgovor STRIKTNO JSON, bez markdowna:',
      '{"date": "YYYY-MM-DD", "confidence": 0.95}',
      'ili {"date": null, "confidence": 0, "reason": "no clear invoice date"}',
    ].join('\n');

    const extracted = [];
    const failed = [];
    const TARGET_LIMIT = Math.min(targetPaths.length, payload.limit || 50);

    for (let i = 0; i < TARGET_LIMIT; i++) {
      const relPath = targetPaths[i];
      const absPath = safeJoin(relPath);
      if (!existsSync(absPath)) {
        failed.push({ path: relPath, reason: 'file not found' });
        continue;
      }
      try {
        const pdfBytes = await readFile(absPath);
        const pdfBase64 = pdfBytes.toString('base64');

        const result = await callAnthropic(
          [{
            role: 'user',
            content: [
              { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
              { type: 'text', text: 'Pronadji INVOICE DATE u ovom racunu i vrati JSON: {"date": "YYYY-MM-DD", "confidence": 0.95} ili {"date": null}.' },
            ],
          }],
          {
            system: systemPrompt,
            max_tokens: 200,
            operation: 'extract-invoice-date',
          }
        );

        const txt = (result.content || []).find(c => c.type === 'text')?.text || '';
        let jsonStr = txt.trim();
        const fence = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fence) jsonStr = fence[1].trim();
        const objMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (objMatch) jsonStr = objMatch[0];

        const parsed = JSON.parse(jsonStr);
        if (parsed.date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date)) {
          dates[relPath] = {
            date: parsed.date,
            confidence: parsed.confidence || 0,
            extractedAt: new Date().toISOString(),
            source: 'ai',
          };
          extracted.push({ path: relPath, date: parsed.date, confidence: parsed.confidence });
        } else if (payload.fallbackToday) {
          // AI nije izvukao datum → fallback na današnji
          const today = new Date().toISOString().slice(0, 10);
          dates[relPath] = {
            date: today,
            source: 'today-fallback',
            extractedAt: new Date().toISOString(),
            note: 'AI nije pronašao invoice date u PDF-u, koristi se današnji datum',
          };
          extracted.push({ path: relPath, date: today, source: 'today-fallback' });
        } else {
          failed.push({ path: relPath, reason: parsed.reason || 'no date detected' });
        }
      } catch (e) {
        if (payload.fallbackToday) {
          const today = new Date().toISOString().slice(0, 10);
          dates[relPath] = {
            date: today,
            source: 'today-fallback',
            extractedAt: new Date().toISOString(),
            note: 'AI parse fail (' + e.message + '), koristi se današnji datum',
          };
          extracted.push({ path: relPath, date: today, source: 'today-fallback' });
        } else {
          failed.push({ path: relPath, reason: e.message });
        }
      }
    }

    await writeFile(datesPath, JSON.stringify(dates, null, 2));

    // Trigger rebuild
    spawn(process.execPath, ['local-libro.mjs'], { cwd: ROOT, stdio: 'ignore', detached: true }).unref();

    return json(res, 200, {
      success: true,
      processed: TARGET_LIMIT,
      extracted: extracted.length,
      failed: failed.length,
      remaining: targetPaths.length - TARGET_LIMIT,
      sampleResults: extracted.slice(0, 10),
      sampleFailed: failed.slice(0, 5),
    });
  } catch (err) {
    console.error('extract-invoice-date ERR:', err);
    json(res, 500, { error: err.message });
  }
}

/**
 * Premjesti misklasificirani fajl iz Invoice 2026/... u IZVODI CO 2026/.
 * Payload: { fromPath, newName? }
 */
async function handleMoveToBank(req, res) {
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body.toString('utf8'));
    if (!payload.fromPath) return json(res, 400, { error: 'Missing fromPath' });
    const fromFull = safeJoin(payload.fromPath);
    if (!existsSync(fromFull)) return json(res, 404, { error: 'Source not found' });

    const newName = payload.newName || fromFull.split(sep).pop();
    const yearMatch = fromFull.match(/(\d{4})/);
    const year = yearMatch ? yearMatch[1] : String(defaultYear());
    const targetDir = bankDir(year);
    await mkdir(targetDir, { recursive: true });
    const targetPath = join(targetDir, newName);

    if (existsSync(targetPath)) {
      // Već postoji u IZVODI/, samo obriši duplicate iz Invoice/
      const { unlink } = await import('fs/promises');
      await unlink(fromFull);
      return json(res, 200, {
        success: true,
        action: 'duplicate-deleted',
        from: payload.fromPath,
        to: targetPath.replace(ROOT + sep, ''),
      });
    }

    const { rename } = await import('fs/promises');
    await rename(fromFull, targetPath);
    spawn(process.execPath, ['local-libro.mjs'], { cwd: ROOT, stdio: 'ignore', detached: true }).unref();
    return json(res, 200, {
      success: true,
      action: 'moved',
      from: payload.fromPath,
      to: targetPath.replace(ROOT + sep, ''),
    });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

/**
 * Pronađe sve PDF/XML u Invoice 2026/ koji izgledaju kao bank statement i vrati listu.
 * User onda može klikom svaki/sve premjestiti u IZVODI/.
 */
async function handleScanMisclassifiedBanks(req, res) {
  try {
    const { readdir } = await import('fs/promises');
    const year = String(new Date().getFullYear());
    const invoiceRoot = join(ROOT, 'Invoice ' + year);
    if (!existsSync(invoiceRoot)) return json(res, 200, { items: [] });

    const items = [];
    async function walk(dir) {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          await walk(p);
        } else if (/\.(pdf|xml)$/i.test(e.name)) {
          // Heuristika: filename ima statement/izvod/hpb/bank prefix
          //   ili je u folderu koji izgleda kao banka
          const isBankName = /^(statement|izvod|hpb|bank|account|stmt)[\-_]/i.test(e.name) ||
                              /^\d{10}\.\d{4}\d{3}\./i.test(e.name);
          const isBankFolder = /\b(HPB|hrvatska_postanska|Banka|Bank)\b/i.test(p);
          if (isBankName || isBankFolder) {
            items.push({
              path: p.replace(ROOT + sep, ''),
              filename: e.name,
              parentFolder: dir.replace(ROOT + sep, ''),
              reason: isBankName ? 'name-pattern' : 'folder-name',
            });
          }
        }
      }
    }
    await walk(invoiceRoot);
    return json(res, 200, { items: items });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

async function handleClaudeUsage(req, res) {
  try {
    let data = { total_usd: 0, by_day: {}, by_operation: {}, last_call: null };
    try { data = JSON.parse(await readFile(CLAUDE_USAGE_FILE, 'utf8')); } catch (_) {}
    const today = new Date().toISOString().slice(0, 10);
    return json(res, 200, {
      success: true,
      configured: !!ANTHROPIC_API_KEY,
      model: ANTHROPIC_MODEL,
      daily_limit_usd: ANTHROPIC_DAILY_LIMIT_USD,
      today_usd: data.by_day[today] || 0,
      total_usd: data.total_usd || 0,
      by_operation: data.by_operation || {},
      by_day: data.by_day || {},
      last_call: data.last_call,
    });
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
}

/**
 * Sync missing bankovni izvodi direktno iz Gmaila preko Gmail API (OAuth).
 * libro-server koristi refresh token (saved u .env preko setup-gmail-auth.mjs)
 * da pristupi Gmailu, search-a HPB threadove, downloadira attachmente i
 * sprema XML+PDF lokalno. Bez Apps Script-a, bez Drive-a.
 *
 * Setup: pokreni `node setup-gmail-auth.mjs` (jednokratno).
 */
/**
 * Pun HPB inbox processing — save attachments + forward na knjigovodstvo + archive thread.
 * Zamjena za Apps Script `hpbAutoSave`. Trči preko Gmail API-ja (gmail.modify scope).
 *
 * Payload (opcijski): { dryRun, since, forwardTo, addLabel }
 */
async function handleHpbAutoProcess(req, res) {
  try {
    if (!GMAIL_REFRESH_TOKEN) {
      return json(res, 400, { error: 'Gmail OAuth nije postavljen. Pokreni: node setup-gmail-auth.mjs' });
    }

    const body = await readBody(req);
    const payload = body.length ? JSON.parse(body.toString('utf8')) : {};
    const dryRun = !!payload.dryRun;
    const forwardTo = payload.forwardTo || getDefaultRecipient();
    if (!forwardTo && !dryRun) return json(res, 400, { error: 'Nema forward recipient-a: postavi `accounting.eRacuniInbox` u libro-config.json ili Settings.' });
    const labelName = payload.addLabel || 'libro/Bank-Forwarded';
    const since = payload.since || (new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '/'));

    const accessToken = await getGmailAccessToken();
    const labelId = await getOrCreateGmailLabel(labelName, accessToken);

    // Search bank statement threads u inboxu (sender iz configa)
    const bankSender = getConfig().bank.statementSenderEmail;
    if (!bankSender) return json(res, 400, { error: 'Nema bank statement sender-a: postavi `bank.statementSenderEmail` u libro-config.json (npr. email banke koji šalje izvode).' });
    const query = `from:${bankSender} has:attachment in:inbox -label:${labelName} after:${since}`;
    const search = await gmailApi(
      `users/me/messages?q=${encodeURIComponent(query)}&maxResults=100`,
      accessToken
    );
    const messageIds = (search.messages || []).map(m => m.id);

    // Pripremi izvodi folder + bank-emails-sent.json
    const dataYear = String(defaultYear());
    const izvodiFolder = bankDir(dataYear);
    await mkdir(izvodiFolder, { recursive: true });

    const bankSentFile = join(ROOT, 'libro-bank-emails-sent.json');
    let bankSent = {};
    try { bankSent = JSON.parse(await readFile(bankSentFile, 'utf8')); } catch (_) {}

    const _acctNum = (getConfig().bank.accountNumber || '').replace(/[^0-9]/g, '');
    const stmtPattern = _acctNum
      ? new RegExp('^' + _acctNum + '\\.(\\d{4})(\\d{3})\\.(xml|pdf)$', 'i')
      : /^(\d{6,16})\.(\d{4})(\d{3})\.(xml|pdf)$/i;
    const userEmail = (await gmailApi('users/me/profile', accessToken)).emailAddress;

    let savedCount = 0, forwardedCount = 0, archivedCount = 0, skippedCount = 0, errorCount = 0;
    const log = [];

    for (const msgId of messageIds) {
      try {
        const msg = await gmailApi(`users/me/messages/${msgId}?format=full`, accessToken);
        const headers = (msg.payload?.headers || []).reduce((h, x) => { h[x.name.toLowerCase()] = x.value; return h; }, {});
        const subject = headers.subject || '';
        const threadId = msg.threadId;

        // Skupi attachments
        const attachments = [];
        function walk(p) {
          if (p.filename && p.body?.attachmentId) {
            const m = p.filename.match(stmtPattern);
            if (m) attachments.push({ filename: p.filename, attachmentId: p.body.attachmentId, mimeType: p.mimeType });
          }
          if (p.parts) p.parts.forEach(walk);
        }
        if (msg.payload) walk(msg.payload);
        if (attachments.length === 0) { skippedCount++; continue; }

        // 1. Save attachments lokalno + skupi za forward
        const forwardAttachments = [];
        for (const att of attachments) {
          const destPath = join(izvodiFolder, att.filename);
          let contentBase64;
          if (existsSync(destPath)) {
            // Vec lokalno — citaj za forward
            contentBase64 = (await readFile(destPath)).toString('base64');
          } else {
            const data = await gmailApi(`users/me/messages/${msgId}/attachments/${att.attachmentId}`, accessToken);
            if (!data.data) continue;
            const b64Std = data.data.replace(/-/g, '+').replace(/_/g, '/');
            const bytes = Buffer.from(b64Std, 'base64');
            if (!dryRun) await writeFile(destPath, bytes);
            contentBase64 = bytes.toString('base64');
            savedCount++;
          }
          forwardAttachments.push({
            filename: att.filename,
            mimeType: att.mimeType || (att.filename.endsWith('.xml') ? 'application/xml' : 'application/pdf'),
            contentBase64,
          });
        }

        // 2. Forward na knjigovodstvo
        if (!dryRun && forwardAttachments.length > 0) {
          const fwdSubject = '[libro] ' + subject;
          const fwdBody = 'Automatski proslijeden HPB izvod.\n\n' +
                          'Originalan subject: ' + subject + '\n' +
                          'Iz inboxa: ' + userEmail + '\n\n' +
                          'U prilogu XML + PDF izvoda.\n\n' +
                          '— libro server';
          const rfc822 = buildRfc822Email({
            from: userEmail,
            to: forwardTo,
            subject: fwdSubject,
            body: fwdBody,
            attachments: forwardAttachments,
          });
          await sendGmailMessage(rfc822, accessToken);
          forwardedCount++;

          // Mark u libro-bank-emails-sent.json
          for (const fa of forwardAttachments) {
            bankSent[fa.filename] = {
              at: new Date().toISOString(),
              to: forwardTo,
              method: 'libro-server-auto-forward',
              note: subject.slice(0, 80),
            };
          }
        }

        // 3. Archive thread (skida iz inboxa) + dodaje libro/HPB-Forwarded label
        if (!dryRun) {
          await archiveGmailThread(threadId, accessToken, [labelId]);
          archivedCount++;
        }

        log.push({ subject: subject.slice(0, 80), saved: attachments.length, forwarded: !dryRun, archived: !dryRun });
      } catch (e) {
        errorCount++;
        log.push({ msgId, error: e.message });
      }
    }

    if (!dryRun) await writeFile(bankSentFile, JSON.stringify(bankSent, null, 2));

    // Trigger rebuild ako smo nesto save-ali
    if (savedCount > 0 && !dryRun) {
      spawn(process.execPath, ['local-libro.mjs'], { cwd: ROOT, stdio: 'ignore', detached: true }).unref();
    }

    // Apple Mail cleanup — ako smo arhivirali u Gmailu, sinkroniziraj Mail.app inbox
    if (archivedCount > 0 && !dryRun && typeof runAppleMailCleanup === 'function') {
      // Daj 10s da Apple Mail uhvati IMAP push, onda cleanup
      setTimeout(() => runAppleMailCleanup(), 10000);
    }

    return json(res, 200, {
      success: true,
      dryRun,
      threadsScanned: messageIds.length,
      saved: savedCount,
      forwarded: forwardedCount,
      archived: archivedCount,
      skipped: skippedCount,
      errors: errorCount,
      log: log.slice(0, 20),
    });
  } catch (err) {
    console.error('hpb-auto-process ERR:', err);
    json(res, 500, { error: err.message });
  }
}

/**
 * Cleanup Apple Mail inbox-a — skida HPB threadove koji su zaglavili u Apple Mail
 * lokalnom cache-u nakon Gmail server-side archive-a.
 * Koristi osascript (AppleScript). Briše iz INBOX-a → Gmail IMAP to translate u
 * "remove INBOX label" (već archived u Gmailu, ovo samo sinkronizira local cache).
 *
 * GET /api/apple-mail-cleanup-hpb (per-account run, async)
 */
async function handleAppleMailCleanupHpb(req, res) {
  try {
    const { spawn: cpSpawn } = await import('child_process');
    const script = `
tell application "Mail"
  set output to {removed:0, accounts:""}
  set totalRemoved to 0
  set accDescriptions to ""
  set accountList to every account
  repeat with acc in accountList
    try
      set accUser to user name of acc
      set inboxList to mailboxes of acc whose name is "INBOX"
      if (count of inboxList) > 0 then
        set inboxMb to item 1 of inboxList
        set hpbMsgs to (every message of inboxMb whose subject contains "[HPB]")
        set hpbCount to count of hpbMsgs
        if hpbCount > 0 then
          repeat with msg in hpbMsgs
            try
              delete msg
              set totalRemoved to totalRemoved + 1
            end try
          end repeat
          set accDescriptions to accDescriptions & accUser & "(" & hpbCount & ") "
        end if
      end if
    end try
  end repeat
  return (totalRemoved as text) & "|" & accDescriptions
end tell
`;
    const p = cpSpawn('osascript', ['-e', script]);
    let stdout = '', stderr = '';
    p.stdout.on('data', d => stdout += d.toString());
    p.stderr.on('data', d => stderr += d.toString());
    p.on('close', (code) => {
      if (code !== 0) {
        return json(res, 500, { error: 'osascript exit ' + code + ': ' + stderr });
      }
      const trimmed = stdout.trim();
      const [removedStr, accStr] = trimmed.split('|');
      json(res, 200, {
        success: true,
        removed: parseInt(removedStr, 10) || 0,
        accountsAffected: (accStr || '').trim(),
      });
    });
    p.on('error', err => json(res, 500, { error: err.message }));
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

/**
 * Bulk-arhivira sve HPB threadove koji su jos u inboxu (bez obzira na label).
 * Cleanup za stare poruke koje su forwardane preko Apps Script-a ali nisu arhivirane.
 */
async function handleHpbArchiveAllInbox(req, res) {
  try {
    if (!GMAIL_REFRESH_TOKEN) return json(res, 400, { error: 'Gmail OAuth nije postavljen' });
    const bankSender = getConfig().bank.statementSenderEmail;
    if (!bankSender) return json(res, 400, { error: 'Nema bank statement sender-a u libro-config.json (bank.statementSenderEmail)' });
    const accessToken = await getGmailAccessToken();
    const labelId = await getOrCreateGmailLabel('libro/Bank-Forwarded', accessToken);

    const query = `from:${bankSender} has:attachment in:inbox`;
    let pageToken = '';
    const messageIds = [];
    let pages = 0;
    do {
      const list = await gmailApi(
        `users/me/messages?q=${encodeURIComponent(query)}&maxResults=100${pageToken ? '&pageToken=' + pageToken : ''}`,
        accessToken
      );
      (list.messages || []).forEach(m => messageIds.push(m.id));
      pageToken = list.nextPageToken;
      pages++;
      if (pages > 5) break;
    } while (pageToken);

    let archived = 0, errors = 0;
    const seenThreads = new Set();
    for (const msgId of messageIds) {
      try {
        const msg = await gmailApi(`users/me/messages/${msgId}?format=metadata&metadataHeaders=Subject`, accessToken);
        const tid = msg.threadId;
        if (seenThreads.has(tid)) continue;
        seenThreads.add(tid);
        await archiveGmailThread(tid, accessToken, [labelId]);
        archived++;
      } catch (e) {
        errors++;
      }
    }
    return json(res, 200, { success: true, archived, errors, totalMessages: messageIds.length, uniqueThreads: seenThreads.size });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

async function handleSyncMissingStatements(req, res) {
  try {
    if (!GMAIL_REFRESH_TOKEN) {
      return json(res, 400, {
        error: 'Gmail OAuth nije postavljen. Pokreni: node setup-gmail-auth.mjs'
      });
    }

    // Procitaj missing seq-ove iz libro-data.json (oni izmedju min i max)
    let dataRaw;
    try {
      dataRaw = await readFile(join(ROOT, 'libro-data.json'), 'utf8');
    } catch (e) {
      return json(res, 500, { error: 'libro-data.json ne postoji — pokreni rebuild prvo.' });
    }
    const data = JSON.parse(dataRaw);
    const gapMissing = (data.missingStatements || []).map(m => parseInt(m.seq, 10));
    const year = String(data.year || '2026');

    const accessToken = await getGmailAccessToken();
    const _cfgBank = getConfig().bank;
    const bankSender = _cfgBank.statementSenderEmail;
    if (!bankSender) return json(res, 400, { error: 'Nema bank statement sender-a (bank.statementSenderEmail) u libro-config.json' });

    // Search Gmail za bank statement threadove
    const query = `from:${bankSender} has:attachment after:${year}/01/01`;
    const searchRes = await gmailApi(
      `users/me/messages?q=${encodeURIComponent(query)}&maxResults=200`,
      accessToken
    );
    if (searchRes.error) throw new Error('Gmail search: ' + searchRes.error.message);
    const messageIds = (searchRes.messages || []).map(m => m.id);

    // Pattern za bank statement file-ove (account number iz configa) i lokalni izvodi folder
    const acctNum = (_cfgBank.accountNumber || '').replace(/[^0-9]/g, '');
    const pattern = acctNum
      ? new RegExp('^' + acctNum + '\\.(\\d{4})(\\d{3})\\.(xml|pdf)$', 'i')
      : /^(\d{6,16})\.(\d{4})(\d{3})\.(xml|pdf)$/i;
    const izvodiFolder = bankDir(year);
    const localFiles = new Set();
    try {
      const { readdir } = await import('fs/promises');
      const list = await readdir(izvodiFolder);
      for (const f of list) localFiles.add(f);
    } catch (_) {}

    // Skupi sve HPB seqs koji u Gmailu postoje. Onda usporedi s gapMissing + nedostajucim novima
    // (sve seq-ove koji su u Gmailu ali nisu lokalno).
    const found = []; // {seq, filename, size}
    const savedFiles = [];
    const foundFilesByKey = new Set(); // 'seq:ext' za dedupe

    for (const msgId of messageIds) {
      const msg = await gmailApi(`users/me/messages/${msgId}?format=full`, accessToken);
      const attachments = findAttachmentsInPayload(msg.payload);

      for (const att of attachments) {
        const m = att.filename.match(pattern);
        if (!m) continue;
        if (m[1] !== year) continue;
        const seq = m[2];
        const ext = m[3].toLowerCase();

        // Skip ako vec lokalno postoji (po filename-u)
        if (localFiles.has(att.filename)) continue;

        const key = seq + ':' + ext;
        if (foundFilesByKey.has(key)) continue;
        foundFilesByKey.add(key);

        // Skidaj attachment binary
        const attData = await gmailApi(
          `users/me/messages/${msgId}/attachments/${att.attachmentId}`,
          accessToken
        );
        if (!attData.data) continue;
        const b64 = attData.data.replace(/-/g, '+').replace(/_/g, '/');
        const bytes = Buffer.from(b64, 'base64');

        const destPath = join(izvodiFolder, att.filename);
        await writeFile(destPath, bytes);
        localFiles.add(att.filename);
        savedFiles.push(att.filename);
        found.push({ seq, filename: att.filename, size: bytes.length });
      }
    }

    const foundSeqs = [...new Set(found.map(f => parseInt(f.seq, 10)))];
    // stillMissing = i gap-ovi koji nisu nađeni + bilo koji "potencijalno novi" (gornji bound)
    // Ne miješamo s gornjim — server uvijek skida sve što vidi u Gmailu a nije lokalno (kod gore).
    const stillMissing = gapMissing.filter(s => !foundSeqs.includes(s));
    const newAboveMax = foundSeqs.filter(s => !gapMissing.includes(s));

    // ─── Bonus: cross-check Gmail Sent → knjigovodstvo za sve izvode ─────────
    // Nakon downloada novih, provjeri koji su lokalno poznati a poslani knjigovodstvu
    // (preko Apps Script auto-forward-a ili rucno). Update libro-bank-emails-sent.json.
    let bankSentMarked = 0;
    try {
      const bankSentFile = join(ROOT, 'libro-bank-emails-sent.json');
      let bankSent = {};
      try { bankSent = JSON.parse(await readFile(bankSentFile, 'utf8')); } catch (_) {}

      const _userCfg = getConfig();
      const _fromAddr = _userCfg.gmail.primaryAccount || '';
      const _recipients = [
        _userCfg.accounting.eRacuniInbox,
        ...(getAccountantEmails() || []),
      ].filter(Boolean);
      if (_recipients.length === 0) {
        // No accounting recipients configured — skip sent cross-check.
        throw new Error('skip-sent-check: no accounting recipients in libro-config.json');
      }
      const _fromClause = _fromAddr ? `from:${_fromAddr} ` : '';
      const _toClause = _recipients.map(r => `to:${r}`).join(' OR ');
      const sentQuery = `${_fromClause}${_toClause} after:${year}/01/01 has:attachment`;
      const sentSearch = await gmailApi(
        `users/me/messages?q=${encodeURIComponent(sentQuery)}&maxResults=200`,
        accessToken
      );
      const sentMsgIds = (sentSearch.messages || []).map(m => m.id);
      // Postoji jos? Skup ukupno svih HPB attachmenta poslano knjigovodstvu (dohvati page-by-page)
      let pageToken = sentSearch.nextPageToken;
      let pages = 0;
      const allSentMsgIds = [...sentMsgIds];
      while (pageToken && pages < 3) {
        const p = await gmailApi(
          `users/me/messages?q=${encodeURIComponent(sentQuery)}&maxResults=100&pageToken=${pageToken}`,
          accessToken
        );
        (p.messages || []).forEach(m => allSentMsgIds.push(m.id));
        pageToken = p.nextPageToken;
        pages++;
      }

      for (const msgId of allSentMsgIds) {
        const msg = await gmailApi(`users/me/messages/${msgId}?format=full`, accessToken);
        const headers = (msg.payload?.headers || []).reduce((h, x) => {
          h[x.name.toLowerCase()] = x.value;
          return h;
        }, {});
        const sentAt = msg.internalDate ? new Date(parseInt(msg.internalDate, 10)).toISOString() : '';
        const to = headers.to || '';
        const subject = headers.subject || '';

        // Walk attachmenti
        const stmtAttachments = [];
        function walk(p) {
          if (p.filename && p.body && p.body.attachmentId) {
            const m = p.filename.match(pattern);
            if (m && m[1] === year) stmtAttachments.push(p.filename);
          }
          if (p.parts) p.parts.forEach(walk);
        }
        if (msg.payload) walk(msg.payload);

        for (const fname of stmtAttachments) {
          if (bankSent[fname]) continue; // vec poznato
          bankSent[fname] = {
            at: sentAt,
            to: to,
            method: 'gmail-sync-scan',
            note: subject.slice(0, 80),
          };
          bankSentMarked++;
        }
      }

      if (bankSentMarked > 0) {
        await writeFile(bankSentFile, JSON.stringify(bankSent, null, 2));
      }
    } catch (e) {
      console.warn('  ⚠ bank-sent crosscheck fail: ' + e.message);
    }

    // Trigger rebuild
    spawn(process.execPath, ['local-libro.mjs'], { cwd: ROOT, stdio: 'ignore', detached: true }).unref();

    return json(res, 200, {
      success: true,
      filesAdded: savedFiles.length,
      filesSaved: savedFiles,
      seqsRequested: gapMissing,
      seqsFound: foundSeqs,
      seqsNewAboveMax: newAboveMax, // novi izvodi iznad lokalnog max-a (npr. tek primljeni)
      seqsStillMissing: stillMissing,
      messagesScanned: messageIds.length,
      bankSentMarked,
    });
  } catch (err) {
    console.error('sync-missing-statements ERR:', err);
    json(res, 500, { error: err.message });
  }
}

async function handleStatementNotSent(req, res) {
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body.toString('utf8'));
    if (!payload.seq) return json(res, 400, { error: 'Missing seq' });

    let data = {};
    try { data = JSON.parse(await readFile(NOT_SENT_STMTS_FILE, 'utf8')); } catch (_) {}

    const key = String(payload.seq).padStart(3, '0');
    if (payload.action === 'unmark') {
      delete data[key];
    } else {
      data[key] = {
        estimatedDate: payload.estimatedDate || '',
        markedAt: new Date().toISOString(),
        note: payload.note || '',
      };
    }
    await writeFile(NOT_SENT_STMTS_FILE, JSON.stringify(data, null, 2));
    spawn(process.execPath, ['local-libro.mjs'], { cwd: ROOT, stdio: 'ignore', detached: true }).unref();
    return json(res, 200, { success: true, total: Object.keys(data).length });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

async function handleInvoiceMetadata(req, res) {
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body.toString('utf8'));
    if (!payload.path) return json(res, 400, { error: 'Missing path' });

    let meta = {};
    try { meta = JSON.parse(await readFile(INVOICE_METADATA_FILE, 'utf8')); } catch (_) {}

    if (payload.action === 'delete') {
      delete meta[payload.path];
    } else {
      const existing = meta[payload.path] || {};
      meta[payload.path] = {
        sourceUrl: payload.sourceUrl != null ? payload.sourceUrl : existing.sourceUrl || '',
        notes:     payload.notes     != null ? payload.notes     : existing.notes     || '',
        updatedAt: new Date().toISOString(),
      };
      // Očisti prazne vrijednosti
      if (!meta[payload.path].sourceUrl) delete meta[payload.path].sourceUrl;
      if (!meta[payload.path].notes) delete meta[payload.path].notes;
    }
    await writeFile(INVOICE_METADATA_FILE, JSON.stringify(meta, null, 2));

    // Auto-rebuild da dashboard odmah vidi novi metadata
    spawn(process.execPath, ['local-libro.mjs'], { cwd: ROOT, stdio: 'ignore', detached: true }).unref();

    return json(res, 200, { success: true, metadata: meta[payload.path] || null });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

async function handleMarkInvoiceEmailSent(req, res) {
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body.toString('utf8'));
    if (!payload.path) return json(res, 400, { error: 'Missing path' });

    let sent = {};
    try { sent = JSON.parse(await readFile(EMAILS_SENT_FILE, 'utf8')); } catch (_) {}

    if (payload.action === 'unmark') {
      delete sent[payload.path];
    } else {
      sent[payload.path] = {
        at: new Date().toISOString(),
        to: payload.to || getDefaultRecipient() || '',
        supplier: payload.supplier || '',
        method: payload.method || 'manual',
      };
    }
    await writeFile(EMAILS_SENT_FILE, JSON.stringify(sent, null, 2));
    spawn(process.execPath, ['local-libro.mjs'], { cwd: ROOT, stdio: 'ignore', detached: true }).unref();
    return json(res, 200, { success: true, total: Object.keys(sent).length });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

async function handleTravelOrder(req, res) {
  try {
    const body = await readBody(req);
    const data = JSON.parse(body.toString('utf8'));
    if (!data.broj || !data.svrha || !data.odrediste) {
      return json(res, 400, { error: 'Missing broj/svrha/odrediste' });
    }
    const year = (data.datumIzdavanja || new Date().toISOString()).slice(0, 4);
    const targetDir = join(ROOT, 'Invoice ' + year, 'Putni nalozi');
    await mkdir(targetDir, { recursive: true });

    // Filename-safe broj: "001/2026" → "001-2026"
    const brojSafe = String(data.broj).replace(/[\/\\:*?"<>|]/g, '-');
    const dest = sanitizeFolder(data.odrediste);
    const base = `PN-${brojSafe}-${dest}`;
    const jsonPath = join(targetDir, base + '.json');
    const htmlPath = join(targetDir, base + '.html');

    // Sačuvaj JSON za kasnije editing/reload
    await writeFile(jsonPath, JSON.stringify(data, null, 2), 'utf8');

    // Sačuvaj HTML za ispis (standalone, ne ovisi o serveru)
    const html = renderTravelOrderHtml(data);
    await writeFile(htmlPath, html, 'utf8');

    // Sačuvaj XML za knjigovodstvo (libro vlastiti format)
    const xmlPath = join(targetDir, base + '.xml');
    const xml = renderTravelOrderXml(data);
    await writeFile(xmlPath, xml, 'utf8');

    // Sačuvaj privike (uploadane PDF-ove/slike) u podfolder
    const priviciPaths = [];
    if (data.privici && data.privici.length > 0) {
      const priviciDir = join(targetDir, base + '_privici');
      await mkdir(priviciDir, { recursive: true });
      for (const p of data.privici) {
        if (!p.filename || !p.contentBase64) continue;
        const safeFn = p.filename.replace(/[\/\\:*?"<>|]/g, '_');
        const pPath = join(priviciDir, safeFn);
        await writeFile(pPath, Buffer.from(p.contentBase64, 'base64'));
        priviciPaths.push(pPath.replace(ROOT + sep, ''));
      }
    }

    return json(res, 200, {
      success: true,
      jsonPath: jsonPath.replace(ROOT + sep, ''),
      htmlPath: htmlPath.replace(ROOT + sep, ''),
      xmlPath: xmlPath.replace(ROOT + sep, ''),
      priviciPaths,
    });
  } catch (err) {
    console.error('travel order error:', err);
    return json(res, 500, { error: err.message });
  }
}

/**
 * Obriši putni nalog (json + html + xml + privici subfolder).
 * Payload: { jsonPath }
 */
async function handleTravelOrderDelete(req, res) {
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body.toString('utf8'));
    if (!payload.jsonPath) return json(res, 400, { error: 'Missing jsonPath' });

    const jsonAbsPath = safeJoin(payload.jsonPath);
    if (!existsSync(jsonAbsPath)) return json(res, 404, { error: 'Putni nalog ne postoji' });
    if (!jsonAbsPath.endsWith('.json')) return json(res, 400, { error: 'Path mora biti .json' });

    const { unlink, rm } = await import('fs/promises');
    const stem = jsonAbsPath.replace(/\.json$/, '');
    const deleted = [];

    // .json
    try { await unlink(jsonAbsPath); deleted.push(payload.jsonPath); } catch (_) {}
    // .html
    if (existsSync(stem + '.html')) {
      try { await unlink(stem + '.html'); deleted.push((stem + '.html').replace(ROOT + sep, '')); } catch (_) {}
    }
    // .xml
    if (existsSync(stem + '.xml')) {
      try { await unlink(stem + '.xml'); deleted.push((stem + '.xml').replace(ROOT + sep, '')); } catch (_) {}
    }
    // _privici/ subfolder
    const priviciDir = stem + '_privici';
    if (existsSync(priviciDir)) {
      try { await rm(priviciDir, { recursive: true, force: true }); deleted.push((priviciDir + '/').replace(ROOT + sep, '')); } catch (_) {}
    }

    return json(res, 200, { success: true, deleted });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

/**
 * AI generira poslovni izvještaj za putni nalog na temelju
 * klijenta + svrhe + osnovnih podataka (datum, odrediste, trajanje).
 * Vraća: { aktivnosti, rezultati, zakljucak } - svaki par rečenica.
 */
async function handleTravelOrderAiReport(req, res) {
  try {
    if (!ANTHROPIC_API_KEY) return json(res, 400, { error: 'ANTHROPIC_API_KEY nije postavljen' });
    const body = await readBody(req);
    const payload = JSON.parse(body.toString('utf8'));
    if (!payload.klijent && !payload.svrha) {
      return json(res, 400, { error: 'Treba bar klijent ili svrha' });
    }

    const ctx = [
      payload.klijent ? `Klijent / sudionici: ${payload.klijent}` : '',
      payload.svrha ? `Svrha sastanka: ${payload.svrha}` : '',
      payload.odrediste ? `Odredište: ${payload.odrediste}` : '',
      payload.polazakVrijeme ? `Polazak: ${payload.polazakVrijeme}` : '',
      payload.povratakVrijeme ? `Povratak: ${payload.povratakVrijeme}` : '',
      payload.dnevnice ? `Trajanje: ${payload.dnevnice} dnevnica` : '',
      payload.svrhaPuta ? `Razlog puta (kratko): ${payload.svrhaPuta}` : '',
    ].filter(Boolean).join('\n');

    const _supT = getSupplier();
    const _whoLine = [_supT.name, _supT.oib && `OIB ${_supT.oib}`].filter(Boolean).join(', ');
    const systemPrompt = [
      `Ti pomažeš pisati poslovni izvještaj za putni nalog${_whoLine ? ' (' + _whoLine + ')' : ''}.`,
      'Knjigovotkinja je tražila KRATAK izvještaj — par rečenica po polju, ne opširno.',
      '',
      'Vrati STRIKTNO JSON, bez markdowna:',
      '{"aktivnosti": "...", "rezultati": "...", "zakljucak": "..."}',
      '',
      'Pravila:',
      '- aktivnosti: 2-3 rečenice što se konkretno radilo (sastanci, radionice, prezentacije)',
      '- rezultati: 2-3 rečenice što je dogovoreno / postignuto',
      '- zakljucak: 1-2 rečenice — uspješnost i sljedeći korak',
      '- Hrvatski jezik, formalni ton, profesionalno',
      '- NE ponavljaj svrhu/klijenta iz inputa — to je već posebno polje',
      '- Konkretno, ne generičko — koristi context koji ti je dan',
    ].join('\n');

    const userMsg = 'Generiraj poslovni izvještaj na temelju:\n\n' + ctx;

    const result = await callAnthropic(
      [{ role: 'user', content: userMsg }],
      { system: systemPrompt, max_tokens: 800, operation: 'travel-report' }
    );
    const txt = (result.content || []).find(c => c.type === 'text')?.text || '';
    let jsonStr = txt.trim();
    const fence = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) jsonStr = fence[1].trim();
    const objM = jsonStr.match(/\{[\s\S]*\}/);
    if (objM) jsonStr = objM[0];

    const parsed = JSON.parse(jsonStr);
    return json(res, 200, {
      success: true,
      aktivnosti: parsed.aktivnosti || '',
      rezultati: parsed.rezultati || '',
      zakljucak: parsed.zakljucak || '',
      cost_usd: result.cost_usd,
    });
  } catch (err) {
    console.error('travel-ai-report ERR:', err);
    json(res, 500, { error: err.message });
  }
}

/**
 * Pošalji izlazni račun (supplier → klijent ili knjigovodstvu) preko Gmail API-ja.
 * Preuzima posao od Apps Script-a (libro-bundle.gs `sendInvoice`).
 * Body je čisti UTF-8 → bez encoding gluposti koje je Apps Script imao.
 *
 * Payload: { data: {invoiceNumber, customer, items, ...}, xmlContent, pdfBase64?, recipient }
 */
async function handleOutgoingInvoiceSend(req, res) {
  try {
    if (!GMAIL_REFRESH_TOKEN) return json(res, 400, { error: 'Gmail OAuth nije postavljen' });
    const body = await readBody(req, 30 * 1024 * 1024);
    const payload = JSON.parse(body.toString('utf8'));
    if (!payload.data || !payload.recipient) return json(res, 400, { error: 'Missing data or recipient' });
    if (!payload.xmlContent) return json(res, 400, { error: 'Missing xmlContent' });

    const d = payload.data;
    const accessToken = await getGmailAccessToken();
    const profile = await gmailApi('users/me/profile', accessToken);
    const senderEmail = profile.emailAddress;
    const _cfgSup = getSupplier();
    const senderName = (d.supplier && d.supplier.name) || _cfgSup.name || 'Korisnik';
    const oib = (d.supplier && d.supplier.oib) || _cfgSup.oib || '';

    const subject = `Izlazni račun ${d.invoiceNumber} · ${(d.customer && d.customer.name) || ''}`;

    // Preferiraj pre-computed totals iz frontend-a; izračunaj sam ako nedostaju (fallback price/unitPrice).
    const itemPrice = it => Number(it.unitPrice != null ? it.unitPrice : it.price) || 0;
    const computedSubtotal = (d.items || []).reduce((s, it) => s + (Number(it.qty || 0) * itemPrice(it)), 0);
    const subtotal = Number(d.subtotal != null ? d.subtotal : computedSubtotal) || 0;
    const vatRate = Number(d.vatRate || 0);
    const vatAmount = Number(d.vatAmount != null ? d.vatAmount : (subtotal * vatRate / 100)) || 0;
    const total = Number(d.total != null ? d.total : (subtotal + vatAmount)) || 0;
    const currency = d.currency || 'EUR';
    const fmt = (n) => Number(n || 0).toLocaleString('hr-HR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + currency;

    const itemsBlock = (d.items || []).length
      ? ['Stavke:', ...(d.items || []).map(it => {
          const line = Number(it.qty || 0) * itemPrice(it);
          return `  · ${it.description || ''} — ${Number(it.qty || 0)} ${it.unit || ''} × ${fmt(itemPrice(it))} = ${fmt(line)}`;
        }), '']
      : [];

    const bodyText = [
      'Pozdrav,',
      '',
      'U privitku šaljem račun ' + d.invoiceNumber + ' za klijenta ' + ((d.customer && d.customer.name) || '') + '.',
      payload.pdfBase64 ? 'Priložen je PDF računa i strojno čitljivi XML.' : 'Priložen je strojno čitljivi XML s podacima računa.',
      '',
      '--- Sažetak ---',
      'Račun: ' + d.invoiceNumber,
      'Izdano: ' + (d.issueDate || ''),
      'Dospijeće: ' + (d.dueDate || ''),
      '',
      ...itemsBlock,
      'Osnovica: ' + fmt(subtotal),
      'PDV (' + vatRate.toFixed(2) + '%): ' + fmt(vatAmount),
      'Ukupno: ' + fmt(total),
      '',
      'Hvala,',
      'Marino',
      '',
      senderName + ' · OIB ' + oib + ' · ' + senderEmail,
    ].join('\n');

    const attachments = [
      {
        filename: d.invoiceNumber + '.xml',
        mimeType: 'application/xml',
        contentBase64: Buffer.from(payload.xmlContent, 'utf8').toString('base64'),
      },
    ];
    if (payload.pdfBase64) {
      attachments.push({
        filename: payload.pdfName || (d.invoiceNumber + '.pdf'),
        mimeType: 'application/pdf',
        contentBase64: payload.pdfBase64,
      });
    }

    const rfc822 = buildRfc822Email({
      from: senderEmail,
      to: payload.recipient,
      subject,
      body: bodyText,
      attachments,
    });
    const messageId = await sendGmailMessage(rfc822, accessToken);

    // Auto-save u "Poslani računi" (libro-outgoing-old.json + outgoing folder/_uploaded_old/)
    try {
      const issueYear = (d.issueDate || new Date().toISOString()).slice(0, 4);
      const targetDir = join(outgoingDir(issueYear), '_uploaded_old');
      await mkdir(targetDir, { recursive: true });

      // Spremi PDF (ako postoji)
      let savedPdfPath = '';
      if (payload.pdfBase64) {
        const pdfFilename = (payload.pdfName || (d.invoiceNumber + '.pdf')).replace(/[\/\\:*?"<>|]/g, '_');
        const pdfDest = join(targetDir, pdfFilename);
        await writeFile(pdfDest, Buffer.from(payload.pdfBase64, 'base64'));
        savedPdfPath = pdfDest.replace(ROOT + sep, '');
      }
      // Spremi XML
      const xmlFilename = (d.invoiceNumber + '.xml').replace(/[\/\\:*?"<>|]/g, '_');
      const xmlDest = join(targetDir, xmlFilename);
      await writeFile(xmlDest, payload.xmlContent, 'utf8');
      const savedXmlPath = xmlDest.replace(ROOT + sep, '');

      // Upiši u libro-outgoing-old.json (metadata)
      const metaFile = join(ROOT, 'libro-outgoing-old.json');
      let meta = {};
      try { meta = JSON.parse(await readFile(metaFile, 'utf8')); } catch (_) {}
      const primaryPath = savedPdfPath || savedXmlPath;
      meta[primaryPath] = {
        invoiceNumber: d.invoiceNumber,
        customer: (d.customer && d.customer.name) || '',
        date: d.issueDate || new Date().toISOString().slice(0, 10),
        total: total,
        currency: 'EUR',
        country: (d.customer && d.customer.country) || '',
        notes: (d.customer && d.customer.address) || '',
        sentTo: payload.recipient,
        sentAt: new Date().toISOString(),
        gmailMessageId: messageId,
        xmlPath: savedXmlPath,
        source: 'libro-generated',
        editedAt: new Date().toISOString(),
      };
      await writeFile(metaFile, JSON.stringify(meta, null, 2));
    } catch (saveErr) {
      console.warn('outgoing-invoice-send save fail:', saveErr.message);
    }

    return json(res, 200, {
      success: true,
      messageId,
      invoiceNumber: d.invoiceNumber,
      recipient: payload.recipient,
      xmlFormat: payload.xmlFormat || 'simple',
    });
  } catch (err) {
    console.error('outgoing-invoice-send ERR:', err);
    json(res, 500, { error: err.message });
  }
}

/**
 * Pošalji putni nalog knjigovodstvu — XML + HTML attached preko Gmail API-ja.
 * Payload: { jsonPath, to? }
 */
async function handleTravelOrderSend(req, res) {
  try {
    if (!GMAIL_REFRESH_TOKEN) return json(res, 400, { error: 'Gmail OAuth nije postavljen' });
    const body = await readBody(req);
    const payload = JSON.parse(body.toString('utf8'));
    if (!payload.jsonPath) return json(res, 400, { error: 'Missing jsonPath' });

    const jsonAbsPath = safeJoin(payload.jsonPath);
    if (!existsSync(jsonAbsPath)) return json(res, 404, { error: 'Putni nalog ne postoji' });
    const data = JSON.parse(await readFile(jsonAbsPath, 'utf8'));

    const xmlPath = jsonAbsPath.replace(/\.json$/, '.xml');
    const htmlPath = jsonAbsPath.replace(/\.json$/, '.html');
    if (!existsSync(xmlPath)) return json(res, 404, { error: 'XML nalog ne postoji — spremi prvo' });

    const xmlContent = await readFile(xmlPath);
    const htmlContent = existsSync(htmlPath) ? await readFile(htmlPath) : null;

    const accessToken = await getGmailAccessToken();
    const profile = await gmailApi('users/me/profile', accessToken);
    const to = payload.to || getDefaultRecipient();
    if (!to) return json(res, 400, { error: 'Nema recipient-a za putni nalog. Postavi accounting.eRacuniInbox u libro-config.json.' });

    const subject = `Putni nalog ${data.broj || '?'} — ${data.svrha || ''} — ${data.odrediste || ''}`;
    const kmTotal = Number(data.km || 0) * Number(data.kmRate || 0);
    const dnevniceTotal = Number(data.dnevnice || 0) * Number(data.dnevnicaRate || 0);
    const ostali = Number(data.cestarina || 0) + Number(data.parking || 0) + Number(data.ostaloIznos || 0);
    const total = kmTotal + dnevniceTotal + ostali;

    const bodyText = [
      'Bok,',
      '',
      'U prilogu putni nalog za knjiženje (XML + HTML).',
      '',
      'Broj: ' + (data.broj || '?'),
      'Datum izdavanja: ' + (data.datumIzdavanja || '?'),
      'Putnik: ' + (data.osoba || '?'),
      'Svrha: ' + (data.svrha || '?'),
      'Relacija: ' + (data.polazakMjesto || '?') + ' → ' + (data.odrediste || '?'),
      'Polazak: ' + (data.polazakVrijeme || '?'),
      'Povratak: ' + (data.povratakVrijeme || '?'),
      '',
      'Obračun:',
      '  Km: ' + data.km + ' × ' + data.kmRate + ' = ' + kmTotal.toFixed(2) + ' €',
      '  Dnevnice: ' + data.dnevnice + ' × ' + data.dnevnicaRate + ' = ' + dnevniceTotal.toFixed(2) + ' €',
      '  Ostali troskovi: ' + ostali.toFixed(2) + ' €',
      '  UKUPNO: ' + total.toFixed(2) + ' €',
      '',
      data.napomene ? 'Napomena: ' + data.napomene : '',
      '',
      '— Marino (libro)',
    ].filter(Boolean).join('\n');

    const attachments = [
      {
        filename: xmlPath.split('/').pop(),
        mimeType: 'application/xml',
        contentBase64: xmlContent.toString('base64'),
      },
    ];
    if (htmlContent) {
      attachments.push({
        filename: htmlPath.split('/').pop(),
        mimeType: 'text/html',
        contentBase64: htmlContent.toString('base64'),
      });
    }

    // Privici (uploadani PDF-ovi/slike u <base>_privici/ subfolder)
    const baseStem = jsonAbsPath.split('/').pop().replace(/\.json$/, '');
    const priviciDir = jsonAbsPath.replace(/\.json$/, '_privici');
    if (existsSync(priviciDir)) {
      const { readdir } = await import('fs/promises');
      for (const fn of await readdir(priviciDir)) {
        try {
          const fpath = join(priviciDir, fn);
          const data = await readFile(fpath);
          const ext = fn.split('.').pop().toLowerCase();
          const mime = ext === 'pdf' ? 'application/pdf'
            : ['jpg','jpeg'].includes(ext) ? 'image/jpeg'
            : ext === 'png' ? 'image/png'
            : 'application/octet-stream';
          attachments.push({ filename: fn, mimeType: mime, contentBase64: data.toString('base64') });
        } catch (_) {}
      }
    }

    const rfc822 = buildRfc822Email({
      from: profile.emailAddress,
      to,
      subject,
      body: bodyText,
      attachments,
    });

    const messageId = await sendGmailMessage(rfc822, accessToken);
    return json(res, 200, { success: true, messageId, to, subject, attachments: attachments.map(a => a.filename) });
  } catch (err) {
    console.error('travel-order-send ERR:', err);
    json(res, 500, { error: err.message });
  }
}

async function handleTravelOrdersList(req, res) {
  try {
    const items = [];
    const year = String(new Date().getFullYear());
    const dir = join(ROOT, 'Invoice ' + year, 'Putni nalozi');
    if (existsSync(dir)) {
      const entries = await (await import('fs/promises')).readdir(dir);
      for (const name of entries) {
        if (!name.endsWith('.json')) continue;
        try {
          const raw = await readFile(join(dir, name), 'utf8');
          const data = JSON.parse(raw);
          data._id = name.replace(/\.json$/, '');
          data._jsonPath = ('Invoice ' + year + '/Putni nalozi/' + name);
          data._htmlPath = data._jsonPath.replace(/\.json$/, '.html');
          items.push(data);
        } catch (_) { /* skip bad JSON */ }
      }
    }
    items.sort((a, b) => (b.generatedAt || '').localeCompare(a.generatedAt || ''));
    return json(res, 200, { items: items });
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
}

/**
 * Generira XML reprezentaciju putnog naloga (libro custom format).
 * Knjigovođa može uvesti taj XML ili ga koristiti kao referencu.
 */
function renderTravelOrderXml(d) {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  const num = (v) => Number(v || 0).toFixed(2);

  const kmTotal = Number(d.km || 0) * Number(d.kmRate || 0);
  const dnevniceTotal = Number(d.dnevnice || 0) * Number(d.dnevnicaRate || 0);
  const ostaliTroskovi = Number(d.cestarina || 0) + Number(d.parking || 0) + Number(d.ostaloIznos || 0);
  const grandTotal = kmTotal + dnevniceTotal + ostaliTroskovi;

  const iz = d.izvjestaj || {};
  const ostaliTroskoviXml = Number(d.cestarina || 0) + Number(d.parking || 0) +
    Number(d.gorivo || 0) + Number(d.smjestaj || 0) + Number(d.reprezentacija || 0) + Number(d.ostalo || 0);

  return `<?xml version="1.0" encoding="UTF-8"?>
<PutniNalog xmlns="urn:libro:putni-nalog:1.0">
  <Header>
    <Broj>${esc(d.broj || '')}</Broj>
    <DatumIzdavanja>${esc(d.datumIzdavanja || '')}</DatumIzdavanja>
    <Generated>${new Date().toISOString()}</Generated>
  </Header>
  <Putnik>
    <Ime>${esc(d.osoba || '')}</Ime>
    <Oib>${esc(d.oib || '')}</Oib>
  </Putnik>
  <Putovanje>
    <Svrha>${esc(d.svrha || '')}</Svrha>
    ${d.klijent ? `<Klijent>${esc(d.klijent)}</Klijent>` : ''}
    <Polazak>
      <Mjesto>${esc(d.polazakMjesto || '')}</Mjesto>
      <Vrijeme>${esc(d.polazakVrijeme || '')}</Vrijeme>
    </Polazak>
    <Odrediste>${esc(d.odrediste || '')}</Odrediste>
    <Povratak>
      <Vrijeme>${esc(d.povratakVrijeme || '')}</Vrijeme>
    </Povratak>
    <Prijevoz>${esc(d.prijevoz || '')}</Prijevoz>
    ${d.reg ? `<Vozilo registracija="${esc(d.reg)}"/>` : ''}
  </Putovanje>
  <Obracun valuta="EUR">
    <Kilometraza>
      <Km>${num(d.km)}</Km>
      <CijenaPoKm>${num(d.kmRate)}</CijenaPoKm>
      <Iznos>${num(kmTotal)}</Iznos>
    </Kilometraza>
    <Dnevnice>
      <Broj>${num(d.dnevnice)}</Broj>
      <CijenaPoDnevnici>${num(d.dnevnicaRate)}</CijenaPoDnevnici>
      <Iznos>${num(dnevniceTotal)}</Iznos>
    </Dnevnice>
    <OstaliTroskovi>
      <Cestarina>${num(d.cestarina)}</Cestarina>
      <Parking>${num(d.parking)}</Parking>
      <Gorivo>${num(d.gorivo)}</Gorivo>
      <Smjestaj>${num(d.smjestaj)}</Smjestaj>
      <Reprezentacija>${num(d.reprezentacija)}</Reprezentacija>
      <Ostalo>${num(d.ostalo)}</Ostalo>
      <Iznos>${num(ostaliTroskoviXml)}</Iznos>
    </OstaliTroskovi>
    <UkupnoZaIsplatu>${num(d.total != null ? d.total : (kmTotal + dnevniceTotal + ostaliTroskoviXml))}</UkupnoZaIsplatu>
  </Obracun>
  ${(iz.svrha || iz.aktivnosti || iz.rezultati || iz.zakljucak) ? `<PoslovniIzvjestaj>
    ${iz.svrha ? `<SvrhaSastanka>${esc(iz.svrha)}</SvrhaSastanka>` : ''}
    ${iz.aktivnosti ? `<Aktivnosti>${esc(iz.aktivnosti)}</Aktivnosti>` : ''}
    ${iz.rezultati ? `<Rezultati>${esc(iz.rezultati)}</Rezultati>` : ''}
    ${iz.zakljucak ? `<Zakljucak>${esc(iz.zakljucak)}</Zakljucak>` : ''}
  </PoslovniIzvjestaj>` : ''}
  ${(d.privici && d.privici.length) ? `<Privici broj="${d.privici.length}">
    ${d.privici.map(p => `<Privitak filename="${esc(p.filename)}" size="${p.sizeBytes || 0}"/>`).join('\n    ')}
  </Privici>` : ''}
  ${d.napomene ? `<Napomene>${esc(d.napomene)}</Napomene>` : ''}
</PutniNalog>`;
}

function renderTravelOrderHtml(d) {
  const _sup = getSupplier();
  const _supName = _sup.name || '';
  const _supAddr = [
    _sup.address,
    _sup.postalCode && _sup.city ? `${_sup.postalCode} ${_sup.city}` : (_sup.city || ''),
  ].filter(Boolean).join(', ');
  const _supOib = _sup.oib || '';
  const money = v => Number(v || 0) > 0
    ? Number(v).toLocaleString('hr-HR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'
    : '—';
  const row = (label, val) => val ? `<tr><th>${label}</th><td>${val}</td></tr>` : '';
  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fmtDate = iso => {
    if (!iso) return '';
    if (/T/.test(iso)) return new Date(iso).toLocaleString('hr-HR');
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}.${m[2]}.${m[1]}.` : iso;
  };
  return `<!DOCTYPE html>
<html lang="hr"><head><meta charset="utf-8"><title>Putni nalog ${esc(d.broj)}</title>
<style>
  @page { size: A4; margin: 18mm; }
  body { font-family: Georgia, 'Times New Roman', serif; color:#1a1a1a; font-size:12pt; max-width:180mm; margin:0 auto; }
  h1 { font-size:20pt; margin:0 0 4pt 0; }
  .sub { font-size:10pt; color:#666; margin-bottom:18pt; }
  .header-grid { display:grid; grid-template-columns:1fr 1fr; gap:16pt; margin-bottom:16pt; }
  .header-grid .box { border:1px solid #ccc; padding:10pt; font-size:10pt; }
  h2 { font-size:13pt; margin:16pt 0 6pt 0; border-bottom:1px solid #000; padding-bottom:2pt; }
  table { width:100%; border-collapse:collapse; font-size:10.5pt; margin-bottom:12pt; }
  th { text-align:left; padding:4pt 8pt 4pt 0; color:#555; font-weight:normal; width:40%; vertical-align:top; }
  td { padding:4pt 0; vertical-align:top; }
  .totals { display:grid; grid-template-columns:1fr 1fr; gap:8pt; margin-top:8pt; }
  .totals .row { display:flex; justify-content:space-between; padding:4pt 0; border-bottom:1px dotted #999; }
  .grand { margin-top:16pt; padding:12pt; background:#f5f2ea; border:1px solid #000; display:flex; justify-content:space-between; align-items:center; font-size:14pt; font-weight:bold; }
  .sig-grid { display:grid; grid-template-columns:1fr 1fr; gap:40pt; margin-top:40pt; }
  .sig-grid .sig { border-top:1px solid #000; padding-top:4pt; text-align:center; font-size:10pt; color:#555; }
  .napomene { font-style:italic; color:#444; white-space:pre-wrap; }
  @media print { .no-print { display:none; } }
  .no-print { margin:20pt 0; text-align:center; }
  .no-print button { padding:10pt 24pt; font-size:12pt; cursor:pointer; }
</style></head><body>

<div class="no-print">
  <button onclick="window.print()">🖨 Ispiši / Sačuvaj kao PDF</button>
</div>

<h1>Putni nalog</h1>
<div class="sub">Broj: <strong>${esc(d.broj)}</strong> · Datum izdavanja: ${fmtDate(d.datumIzdavanja)}</div>

<div class="header-grid">
  <div class="box">
    <strong>Nalog izdaje</strong><br>
    ${esc(_supName)}<br>
    ${esc(_supAddr)}<br>
    ${_supOib ? 'OIB: ' + esc(_supOib) : ''}
  </div>
  <div class="box">
    <strong>Osoba koja putuje</strong><br>
    ${esc(d.osoba)}<br>
    OIB: ${esc(d.oib)}
  </div>
</div>

<h2>Podaci o putovanju</h2>
<table>
  ${row('Svrha putovanja', esc(d.svrha))}
  ${row('Polazak', esc(d.polazakMjesto))}
  ${row('Odredište', esc(d.odrediste))}
  ${row('Datum i vrijeme polaska', fmtDate(d.polazakVrijeme))}
  ${row('Datum i vrijeme povratka', fmtDate(d.povratakVrijeme))}
  ${row('Prijevozno sredstvo', esc(d.prijevoz))}
  ${row('Registarska oznaka', esc(d.reg))}
</table>

<h2>Obračun troškova</h2>
<div class="totals">
  <div class="row"><span>Kilometraža (${d.km} km × ${money(d.kmRate)}/km)</span><span>${money(d.kmTotal)}</span></div>
  <div class="row"><span>Dnevnice (${d.dnevnice} × ${money(d.dnevnicaRate)})</span><span>${money(d.dnevniceTotal)}</span></div>
  <div class="row"><span>Cestarina</span><span>${money(d.cestarina)}</span></div>
  <div class="row"><span>Parking</span><span>${money(d.parking)}</span></div>
  <div class="row"><span>Gorivo</span><span>${money(d.gorivo)}</span></div>
  <div class="row"><span>Smještaj</span><span>${money(d.smjestaj)}</span></div>
  <div class="row"><span>Reprezentacija</span><span>${money(d.reprezentacija)}</span></div>
  <div class="row"><span>Ostalo</span><span>${money(d.ostalo)}</span></div>
</div>

<div class="grand">
  <span>UKUPNO ZA ISPLATU</span>
  <span>${money(d.total)}</span>
</div>

${(() => {
  const iz = d.izvjestaj || {};
  const hasReport = iz.svrha || iz.aktivnosti || iz.rezultati || iz.zakljucak;
  if (!hasReport) return '';
  return `<h2>Poslovni izvještaj</h2>
<div class="izvjestaj">
  ${d.klijent ? `<p><strong>Klijent / sudionici:</strong> ${esc(d.klijent)}</p>` : ''}
  ${iz.svrha ? `<p><strong>Svrha sastanka:</strong> ${esc(iz.svrha)}</p>` : ''}
  ${iz.aktivnosti ? `<p><strong>Aktivnosti tijekom boravka:</strong> ${esc(iz.aktivnosti)}</p>` : ''}
  ${iz.rezultati ? `<p><strong>Rezultati / dogovori:</strong> ${esc(iz.rezultati)}</p>` : ''}
  ${iz.zakljucak ? `<p><strong>Zaključak:</strong> ${esc(iz.zakljucak)}</p>` : ''}
</div>`;
})()}

${(d.privici && d.privici.length) ? `<h2>Priloženi računi</h2>
<ul class="privici">
  ${d.privici.map(p => `<li>${esc(p.filename)} <span style="color:#666;font-size:11px;">(${((p.sizeBytes||0)/1024).toFixed(0)} KB)</span></li>`).join('\n  ')}
</ul>` : ''}

${d.napomene ? `<h2>Napomene</h2><div class="napomene">${esc(d.napomene)}</div>` : ''}

<div class="sig-grid">
  <div class="sig">Potpis osobe koja putuje</div>
  <div class="sig">Potpis odgovorne osobe (M.P.)</div>
</div>

</body></html>`;
}

async function handleForwardMark(req, res) {
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body.toString('utf8'));
    if (!payload.ref) return json(res, 400, { error: 'Missing ref' });

    let fwd = {};
    try {
      const raw = await readFile(FORWARDED_FILE, 'utf8');
      fwd = JSON.parse(raw);
    } catch (_) { /* file doesn't exist yet */ }

    if (payload.action === 'unmark') {
      delete fwd[payload.ref];
    } else {
      fwd[payload.ref] = {
        note: payload.note || 'Poslano iz Gmaila',
        at: new Date().toISOString(),
        supplier: payload.supplier || '',
        amount: payload.amount || 0,
      };
    }
    await writeFile(FORWARDED_FILE, JSON.stringify(fwd, null, 2));

    // Auto-rebuild
    spawn(process.execPath, ['local-libro.mjs'], { cwd: ROOT, stdio: 'ignore', detached: true }).unref();

    return json(res, 200, { success: true, forwarded: Object.keys(fwd).length });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

async function handleOpen(req, res) {
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body.toString('utf8'));
    if (!payload.path) return json(res, 400, { error: 'Missing path' });
    const full = safeJoin(payload.path);
    if (!existsSync(full)) return json(res, 404, { error: 'Not found' });
    spawn('open', [full], { detached: true }).unref();
    json(res, 200, { success: true });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

async function serveStatic(req, res, url) {
  try {
    let p = decodeURIComponent(url.pathname);
    if (p === '/' || p === '') {
      // First-run gating: ako setup nije gotov, redirect na setup wizard.
      if (isFirstRun() && existsSync(join(ROOT, 'setup.html'))) {
        res.writeHead(302, { Location: '/setup.html' });
        return res.end();
      }
      p = '/dashboard.html';
    }
    // Legacy alias za stari URL.
    if (p === '/racunovodstvo-dashboard.html') p = '/dashboard.html';
    const full = safeJoin(p);
    const s = await stat(full).catch(() => null);
    if (!s || !s.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404 ' + p);
    }
    const mime = MIME[extname(full).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': s.size,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    });
    createReadStream(full).pipe(res);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('500 ' + err.message);
  }
}

// ───────────────────────────────────────────────────────────
// CONFIG — save / setup wizard endpoint
// ───────────────────────────────────────────────────────────
async function handleConfigSave(req, res) {
  try {
    const body = await readBody(req);
    const payload = JSON.parse(body.toString('utf8'));
    const updates = payload.config || payload.updates || payload;
    const markComplete = payload.markComplete === true || payload.completeSetup === true;
    // Sanity: ne dopuštamo brisanje `version`
    if (updates && typeof updates === 'object') delete updates.version;
    const next = await saveConfig(updates || {}, { markComplete });
    return json(res, 200, { success: true, config: next, setupCompleted: next.setupCompleted === true });
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
}

// ───────────────────────────────────────────────────────────
// SERVER
// ───────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const method = req.method.toUpperCase();

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // API endpoints
  if (method === 'POST') {
    if (url.pathname === '/api/config')        return handleConfigSave(req, res);
    if (url.pathname === '/api/upload')        return handleUpload(req, res);
    if (url.pathname === '/api/rebuild')       return handleRebuild(req, res);
    if (url.pathname === '/api/ignore')        return handleIgnore(req, res);
    if (url.pathname === '/api/open')          return handleOpen(req, res);
    if (url.pathname === '/api/travel-order')  return handleTravelOrder(req, res);
    if (url.pathname === '/api/travel-order/send') return handleTravelOrderSend(req, res);
    if (url.pathname === '/api/travel-order/ai-report') return handleTravelOrderAiReport(req, res);
    if (url.pathname === '/api/travel-order/delete') return handleTravelOrderDelete(req, res);
    if (url.pathname === '/api/outgoing-invoice/send') return handleOutgoingInvoiceSend(req, res);
    if (url.pathname === '/api/forward-mark')  return handleForwardMark(req, res);
    if (url.pathname === '/api/send-invoice-email') return handleSendInvoiceEmail(req, res);
    if (url.pathname === '/api/mark-email-sent')    return handleMarkInvoiceEmailSent(req, res);
    if (url.pathname === '/api/invoice-metadata')   return handleInvoiceMetadata(req, res);
    if (url.pathname === '/api/statement-not-sent') return handleStatementNotSent(req, res);
    if (url.pathname === '/api/send-statement-email') return handleSendStatementEmail(req, res);
    if (url.pathname === '/api/mark-statement-email-sent') return handleMarkStatementEmailSent(req, res);
    if (url.pathname === '/api/check-mail-rule') return handleCheckMailRule(req, res);
    if (url.pathname === '/api/claude/parse-pdf') return handleClaudeParsePdf(req, res);
    if (url.pathname === '/api/claude/parse-outgoing-pdf') return handleClaudeParseOutgoingPdf(req, res);
    if (url.pathname === '/api/claude/chat') return handleClaudeChat(req, res);
    if (url.pathname === '/api/clients/save')   return handleClientsSave(req, res);
    if (url.pathname === '/api/clients/delete') return handleClientsDelete(req, res);
    if (url.pathname === '/api/clients/dedupe') return handleClientsDedupe(req, res);
    if (url.pathname === '/api/move-to-bank') return handleMoveToBank(req, res);
    if (url.pathname === '/api/scan-misclassified-banks') return handleScanMisclassifiedBanks(req, res);
    if (url.pathname === '/api/sync-missing-statements') return handleSyncMissingStatements(req, res);
    if (url.pathname === '/api/hpb-auto-process') return handleHpbAutoProcess(req, res);
    if (url.pathname === '/api/hpb-archive-all-inbox') return handleHpbArchiveAllInbox(req, res);
    if (url.pathname === '/api/ai-match-missing') return handleAiMatchMissing(req, res);
    if (url.pathname === '/api/claude/extract-invoice-date') return handleClaudeExtractInvoiceDate(req, res);
    if (url.pathname === '/api/invoice-date-set') return handleInvoiceDateSet(req, res);
    if (url.pathname === '/api/accountant/download') return handleAccountantDownload(req, res);
    if (url.pathname === '/api/accountant/ai-categorize') return handleAccountantAiCategorize(req, res);
    if (url.pathname === '/api/outgoing-old/upload') return handleOutgoingOldUpload(req, res);
    if (url.pathname === '/api/outgoing-old/ai-parse') return handleOutgoingOldAiParse(req, res);
    if (url.pathname === '/api/outgoing-old/edit') return handleOutgoingOldEdit(req, res);
    if (url.pathname === '/api/outgoing-old/delete') return handleOutgoingOldDelete(req, res);
    if (url.pathname === '/api/outgoing-arhiva/restore') return handleOutgoingArhivaRestore(req, res);
    if (url.pathname === '/api/accountant-docs/upload') return handleAccountantDocsUpload(req, res);
    if (url.pathname === '/api/reminders') return handleRemindersSave(req, res);
    return json(res, 404, { error: 'Unknown POST endpoint' });
  }

  if (method === 'GET') {
    if (url.pathname === '/api/status') {
      return json(res, 200, { ok: true, root: ROOT, port: PORT, time: new Date().toISOString() });
    }
    if (url.pathname === '/api/setup-status') {
      return json(res, 200, { firstRun: isFirstRun(), setupCompleted: !isFirstRun() });
    }
    if (url.pathname === '/api/config') {
      // Vrati config — bez secreta (.env-i ostaju u .env)
      return json(res, 200, getConfig({ fresh: true }));
    }
    if (url.pathname === '/api/travel-orders') return handleTravelOrdersList(req, res);
    if (url.pathname === '/api/claude/usage') return handleClaudeUsage(req, res);
    if (url.pathname === '/api/accountant/emails') return handleAccountantEmails(req, res);
    if (url.pathname === '/api/outgoing-old') return handleOutgoingOldList(req, res);
    if (url.pathname === '/api/outgoing-arhiva') return handleOutgoingArhivaList(req, res);
    if (url.pathname === '/api/storage-stats') return handleStorageStats(req, res);
    if (url.pathname === '/api/apple-mail-cleanup-hpb') return handleAppleMailCleanupHpb(req, res);
    if (url.pathname === '/api/accountant-docs') return handleAccountantDocsList(req, res);
    if (url.pathname === '/api/reminders') return handleRemindersList(req, res);
    if (url.pathname === '/api/clients/list') return handleClientsList(req, res);
    return serveStatic(req, res, url);
  }

  res.writeHead(405);
  res.end('Method not allowed');
});

server.listen(PORT, () => {
  const _isFirst = isFirstRun();
  console.log(`▸ libro server running`);
  if (_isFirst) {
    console.log(`  ⚠ First-run: setup wizard će se otvoriti automatski`);
    console.log(`  http://localhost:${PORT}/setup.html`);
  } else {
    console.log(`  http://localhost:${PORT}/dashboard.html`);
  }
  console.log(`  root: ${ROOT}`);
  console.log('');
  console.log('  GET  /api/config           — vrati trenutni libro-config.json');
  console.log('  POST /api/config           — spremi izmjene u libro-config.json');
  console.log('  POST /api/upload           — sprema dolazni račun PDF');
  console.log('  POST /api/rebuild          — regenerira libro-data.json');
  if (isGmailEnabled()) console.log('  POST /api/bank-auto-process — sync bank statements (Gmail)');
  console.log('');
});

// ⚠ DISABLED 2026-05-07: Apple Mail `delete msg` u IMAP kontekstu šalje threadove u
// Gmail TRASH umjesto archive-a — to je uzrokovalo da svi novi HPB izvodi nestanu
// u Trash-u (i posljedično ne budu skinuti u sync). Gmail-side arhiva se već radi
// preko `archiveGmailThread()` u `handleHpbAutoProcess` (cron svakih 5 min, linija ~4070),
// pa je AppleScript cleanup redundantan. Function ostaje za reference + manual call
// preko `/api/apple-mail-cleanup-hpb`, ali cron je ugašen.
async function runAppleMailCleanup() {
  // no-op
}
// setInterval ugašen.

// Auto-process bank inbox svakih 5 min — radi samo ako je u configu uključeno.
// Trči samo ako je gmail.modify scope dostupan i bank.statementSenderEmail postavljen.
const HPB_AUTO_INTERVAL_MS = 5 * 60 * 1000;
async function runHpbAutoProcessTimer() {
  if (!GMAIL_REFRESH_TOKEN) return;
  const bankSender = getConfig().bank.statementSenderEmail;
  if (!bankSender) return;  // bez sender-a ne znamo gdje tražiti
  try {
    const accessToken = await getGmailAccessToken();
    const labelId = await getOrCreateGmailLabel('libro/Bank-Forwarded', accessToken);
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '/');
    const query = `from:${bankSender} has:attachment in:inbox -label:libro/Bank-Forwarded after:${since}`;
    const search = await gmailApi(`users/me/messages?q=${encodeURIComponent(query)}&maxResults=20`, accessToken);
    const messageIds = (search.messages || []).map(m => m.id);
    if (messageIds.length === 0) return;
    console.log('[hpb-auto] Processing ' + messageIds.length + ' new HPB threads…');
    // Reuse handler logic: pozovi internal direktno
    const fakeReq = { url: '/api/hpb-auto-process', method: 'POST', headers: {}, on(){}, [Symbol.asyncIterator]: async function*(){} };
    const fakeRes = {
      writeHead() {}, end() {}, setHeader() {},
    };
    // Zovi POST handler izravno (ne preko HTTP-a)
    await handleHpbAutoProcess(
      { headers: {}, on: () => {}, [Symbol.asyncIterator]: async function*() { yield Buffer.from('{}'); } },
      { writeHead: () => {}, end: (txt) => {
        try { const r = JSON.parse(txt); console.log('[hpb-auto] saved=' + r.saved + ' forwarded=' + r.forwarded + ' archived=' + r.archived); }
        catch (_) {}
      }, setHeader: () => {} }
    );
  } catch (e) {
    console.warn('[hpb-auto] err:', e.message);
  }
}
// Pokreni svakih 5 min
setInterval(runHpbAutoProcessTimer, HPB_AUTO_INTERVAL_MS);
// Plus jedan put 30s nakon starta
setTimeout(runHpbAutoProcessTimer, 30 * 1000);
