// libro cleanup scan
//
// Radi 2 stvari:
//   1. Skenira `Invoice 2026/` za EXACT duplikate (isti SHA256 hash sadrzaja)
//   2. Provjerava Gmail Sent folder za attachmente poslane knjigovodstvu
//      i cross-matcha s lokalnim PDF-ovima → predlozi update libro-emails-sent.json
//
// Pokreni:
//   node scan-cleanup.mjs                  # dry-run report
//   node scan-cleanup.mjs --apply-sent     # mark match-ane PDF-ove kao poslane
//   node scan-cleanup.mjs --archive-dupes  # premjesti DUPE fajlove u _arhiva/duplikati/<datum>/
//   node scan-cleanup.mjs --delete-dupes   # obrisi DUPE fajlove (samo ako stvarno hoces!)

import { readdirSync, readFileSync, writeFileSync, statSync, existsSync, unlinkSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const ROOT = dirname(fileURLToPath(import.meta.url));
const INVOICE_FOLDER = join(ROOT, 'Invoice 2026');
const EMAILS_SENT_FILE = join(ROOT, 'libro-emails-sent.json');
const ENV_PATH = join(ROOT, '.env');

const APPLY_SENT = process.argv.includes('--apply-sent');
const DELETE_DUPES = process.argv.includes('--delete-dupes');
const ARCHIVE_DUPES = process.argv.includes('--archive-dupes');

// Učitaj accountant recipients iz libro-config.json (config-driven).
let ACCOUNTANT_RECIPIENTS = [];
try {
  const cfg = JSON.parse(readFileSync(join(process.cwd(), 'libro-config.json'), 'utf8'));
  const a = cfg.accounting || {};
  ACCOUNTANT_RECIPIENTS = [a.eRacuniInbox, a.primaryEmail, ...(a.secondaryEmails || [])].filter(Boolean);
} catch (_) {
  // Config nedostaje — skripta će vjerojatno biti useless, ali ne crash-amo.
}

// ---- helpers ----
function loadEnv() {
  if (!existsSync(ENV_PATH)) return {};
  const env = {};
  readFileSync(ENV_PATH, 'utf8').split('\n').forEach((line) => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const eq = line.indexOf('=');
    if (eq < 0) return;
    env[line.substring(0, eq).trim()] = line.substring(eq + 1).trim().replace(/^['"]|['"]$/g, '');
  });
  return env;
}

function walkPdfs(folder) {
  const out = [];
  function walk(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) {
        try {
          const stats = statSync(full);
          const buf = readFileSync(full);
          const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16);
          out.push({
            absPath: full,
            relPath: full.replace(ROOT + '/', ''),
            filename: entry.name,
            size: stats.size,
            hash,
            mtime: stats.mtime,
          });
        } catch (e) {
          console.warn('  ⚠ skip ' + full + ': ' + e.message);
        }
      }
    }
  }
  walk(folder);
  return out;
}

const env = loadEnv();
const GMAIL_CLIENT_ID = env.GMAIL_CLIENT_ID || '';
const GMAIL_CLIENT_SECRET = env.GMAIL_CLIENT_SECRET || '';
const GMAIL_REFRESH_TOKEN = env.GMAIL_REFRESH_TOKEN || '';

let _gmailAccessToken = null;
async function getGmailAccessToken() {
  if (_gmailAccessToken) return _gmailAccessToken;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GMAIL_CLIENT_ID,
      client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }).toString(),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('OAuth fail: ' + JSON.stringify(data));
  _gmailAccessToken = data.access_token;
  return _gmailAccessToken;
}

async function gmailApi(endpoint, token) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error('Non-JSON: ' + text.slice(0, 200)); }
}

function findAttachmentsInPayload(payload) {
  const out = [];
  function walk(part) {
    if (part.filename && part.body && part.body.attachmentId) {
      out.push({
        filename: part.filename,
        attachmentId: part.body.attachmentId,
        size: part.body.size || 0,
      });
    }
    if (part.parts) part.parts.forEach(walk);
  }
  if (payload) walk(payload);
  return out;
}

// ---- 1. Lokalni duplikati ----
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  libro cleanup scan');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');
console.log('▸ Skeniram Invoice 2026/...');
const pdfs = walkPdfs(INVOICE_FOLDER);
console.log(`  ✓ ${pdfs.length} PDF fajlova`);

// Group by SHA hash
const byHash = {};
for (const pdf of pdfs) {
  if (!byHash[pdf.hash]) byHash[pdf.hash] = [];
  byHash[pdf.hash].push(pdf);
}

const exactDupes = Object.values(byHash)
  .filter((g) => g.length > 1)
  .sort((a, b) => b.length - a.length);

const dupesCount = exactDupes.reduce((s, g) => s + g.length - 1, 0);
console.log('');
console.log(`▸ EXACT DUPLIKATI (identican SHA256 hash):`);
console.log(`  ${exactDupes.length} grupa · ${dupesCount} viska fajlova`);

if (exactDupes.length === 0) {
  console.log('  (nema duplikata)');
} else {
  console.log('');
  exactDupes.forEach((group, i) => {
    // Sortaj po path-u, prvo .../Placanje X/Supplier/file.pdf, zadnje root level
    group.sort((a, b) => a.relPath.length - b.relPath.length);
    console.log(`  [${i + 1}] ${group[0].size.toLocaleString()} bytes · hash ${group[0].hash}`);
    group.forEach((p, j) => {
      const marker = j === 0 ? 'KEEP' : 'DUPE';
      const color = j === 0 ? '\x1b[32m' : '\x1b[33m';
      console.log(`      ${color}${marker}\x1b[0m · ${p.relPath}`);
    });
  });
}

// ---- 2. Gmail Sent crosscheck ----
console.log('');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

if (!GMAIL_REFRESH_TOKEN) {
  console.log('  ⚠ Gmail OAuth nije postavljen — preskocim sent crosscheck.');
  console.log('     Pokreni: node setup-gmail-auth.mjs');
  process.exit(0);
}

console.log('▸ Trazim Gmail Sent → knjigovodstvo...');
const accessToken = await getGmailAccessToken();

const toFilter = ACCOUNTANT_RECIPIENTS.map((r) => `to:${r}`).join(' OR ');
const query = `(${toFilter}) has:attachment after:2026/01/01`;
console.log(`  Query: ${query}`);

const search = await gmailApi(
  `users/me/messages?q=${encodeURIComponent(query)}&maxResults=200`,
  accessToken
);

const messageIds = (search.messages || []).map((m) => m.id);
console.log(`  ✓ ${messageIds.length} poruka s attachment-om`);

// Za svaku poruku: dohvati attachmente (filename + size)
console.log('  → dohvacam attachment metadata...');
const sentAttachments = [];
for (const id of messageIds) {
  const msg = await gmailApi(`users/me/messages/${id}?format=metadata`, accessToken);
  const headers = (msg.payload?.headers || []).reduce((h, x) => {
    h[x.name.toLowerCase()] = x.value;
    return h;
  }, {});
  // Metadata format ne daje attachmente — treba full
  const full = await gmailApi(`users/me/messages/${id}?format=full`, accessToken);
  const atts = findAttachmentsInPayload(full.payload);
  for (const att of atts) {
    if (!/\.(pdf|xml)$/i.test(att.filename)) continue;
    sentAttachments.push({
      filename: att.filename,
      size: att.size,
      sentAt: msg.internalDate ? new Date(parseInt(msg.internalDate, 10)).toISOString() : '',
      to: headers.to || '',
      subject: headers.subject || '',
      messageId: id,
    });
  }
}

console.log(`  ✓ ${sentAttachments.length} attachment-a (PDF/XML)`);

// Match po filename + size protiv lokalnih PDF-ova
const sentMap = new Map(); // 'filename|size' → att
for (const att of sentAttachments) {
  const key = att.filename + '|' + att.size;
  if (!sentMap.has(key)) sentMap.set(key, att);
}

const localMatched = []; // {pdf, att}
const localUnmatched = [];
for (const pdf of pdfs) {
  const key = pdf.filename + '|' + pdf.size;
  const att = sentMap.get(key);
  if (att) localMatched.push({ pdf, att });
  else localUnmatched.push(pdf);
}

console.log('');
console.log(`▸ MATCH lokalni PDF ↔ Gmail Sent attachment:`);
console.log(`  ${localMatched.length} match-ano · ${localUnmatched.length} nije pronadjeno u Sent`);

// Procitaj postojeci libro-emails-sent.json
let emailsSent = {};
if (existsSync(EMAILS_SENT_FILE)) {
  emailsSent = JSON.parse(readFileSync(EMAILS_SENT_FILE, 'utf8'));
}

const alreadyMarked = localMatched.filter(({ pdf }) => emailsSent[pdf.relPath]);
const newlyDetected = localMatched.filter(({ pdf }) => !emailsSent[pdf.relPath]);

console.log(`  ${alreadyMarked.length} vec u libro-emails-sent.json`);
console.log(`  ${newlyDetected.length} NOVO detektirano (treba mark)`);

if (newlyDetected.length > 0) {
  console.log('');
  console.log('  Novo detektirano (ne u libro-emails-sent.json):');
  newlyDetected.slice(0, 25).forEach(({ pdf, att }) => {
    const date = att.sentAt ? new Date(att.sentAt).toLocaleDateString('hr-HR') : '?';
    console.log(`    · ${date} · ${pdf.filename}`);
    console.log(`      → ${pdf.relPath}`);
    console.log(`      to: ${att.to.slice(0, 80)}`);
  });
  if (newlyDetected.length > 25) console.log(`    ... + ${newlyDetected.length - 25} jos`);
}

// ---- 3. Apply changes ----
console.log('');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

if (ARCHIVE_DUPES && exactDupes.length > 0) {
  const today = new Date().toISOString().slice(0, 10);
  const archiveRoot = join(ROOT, '_arhiva', 'duplikati', today);
  console.log(`▸ ARCHIVE_DUPES — premjestam u _arhiva/duplikati/${today}/...`);
  let moved = 0;
  for (const group of exactDupes) {
    group.sort((a, b) => a.relPath.length - b.relPath.length);
    for (let j = 1; j < group.length; j++) {
      const src = group[j].absPath;
      // Cuvaj originalni relativni path da znas odakle je dosao
      const dst = join(archiveRoot, group[j].relPath);
      try {
        mkdirSync(dirname(dst), { recursive: true });
        renameSync(src, dst);
        console.log(`  → ${group[j].relPath}`);
        moved++;
      } catch (e) {
        console.warn(`  ⚠ failed: ${group[j].relPath}: ${e.message}`);
      }
    }
  }
  console.log(`  ✓ premjesteno ${moved} fajla u _arhiva/duplikati/${today}/`);
  console.log(`  (libro ih nece skenirati — _arhiva/ je izvan Invoice 2026/)`);
} else if (DELETE_DUPES && exactDupes.length > 0) {
  console.log('▸ DELETE_DUPES — brisem viska fajlove (PERMANENTNO)...');
  let deleted = 0;
  for (const group of exactDupes) {
    group.sort((a, b) => a.relPath.length - b.relPath.length);
    for (let j = 1; j < group.length; j++) {
      try {
        unlinkSync(group[j].absPath);
        console.log(`  ✗ ${group[j].relPath}`);
        deleted++;
      } catch (e) {
        console.warn(`  ⚠ failed: ${group[j].relPath}: ${e.message}`);
      }
    }
  }
  console.log(`  ✓ obrisao ${deleted} fajla`);
} else if (exactDupes.length > 0) {
  console.log(`  (dry-run) — opcije:`);
  console.log(`    --archive-dupes  premjesti u _arhiva/duplikati/ (preporuka)`);
  console.log(`    --delete-dupes   permanentno obrisi`);
}

if (APPLY_SENT && newlyDetected.length > 0) {
  console.log('');
  console.log('▸ APPLY_SENT — markiram nove kao poslano...');
  for (const { pdf, att } of newlyDetected) {
    emailsSent[pdf.relPath] = {
      at: att.sentAt,
      to: att.to,
      supplier: pdf.relPath.split('/').slice(-2, -1)[0] || '',
      method: 'gmail-sent-crosscheck',
    };
  }
  writeFileSync(EMAILS_SENT_FILE, JSON.stringify(emailsSent, null, 2));
  console.log(`  ✓ ${newlyDetected.length} fajlova oznaceno kao poslano`);
  console.log(`  → ${EMAILS_SENT_FILE}`);
} else if (newlyDetected.length > 0) {
  console.log(`  (dry-run) — pokreni s --apply-sent da markiras ${newlyDetected.length} novih kao poslano`);
}

console.log('');
console.log('Done.');
