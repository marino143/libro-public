#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
//  libro local processor — čita iz Drive-synced foldera
//  ────────────────────────────────────────────────────────────────────
//  Nikakav Apps Script, nikakvi Sheetovi, nikakav fuzzy finder encoding
//  kaos. Radi DIREKTNO na lokalnim fajlovima (sync preko Google Drive
//  for Desktop).
//
//  Input:
//    Invoice 2026/Placanje MMM 26/SUPPLIER/*.pdf   (svi računi)
//    IZVODI CO 2026/*.xml                          (HPB camt.053 izvodi)
//
//  Output:
//    libro-data.json  (single file koji dashboard čita preko fetch)
//
//  Usage:  node local-libro.mjs [--year 2026]
//          ili:  npm run rebuild
// ═══════════════════════════════════════════════════════════════════════════

import { readdir, readFile, writeFile, stat } from 'fs/promises';
import { join, basename, extname, relative } from 'path';
import { existsSync } from 'fs';
import { getConfig, folderPath, defaultYear } from './libro-config.mjs';

const ROOT = process.cwd();

const YEAR = (() => {
  const i = process.argv.indexOf('--year');
  if (i >= 0) return process.argv[i + 1];
  return String(defaultYear());
})();

// Config-driven folder paths — fallback na sensible defaults ako config nije setup.
const INVOICE_DIR = folderPath('incomingInvoices', YEAR);
const BANK_DIR = folderPath('bankStatements', YEAR);
const OUT_FILE = join(ROOT, 'libro-data.json');
const FORWARDED_FILE = join(ROOT, 'libro-forwarded.json');   // TX annotations (forwarded bez PDF-a)
const IGNORED_FILE = join(ROOT, 'libro-ignored.json');       // TX annotations (ignored)
const EMAILS_SENT_FILE = join(ROOT, 'libro-emails-sent.json'); // invoice → email sent log
const INVOICE_METADATA_FILE = join(ROOT, 'libro-invoice-metadata.json'); // invoice → { sourceUrl, notes }
const NOT_SENT_STMTS_FILE = join(ROOT, 'libro-not-sent-statements.json'); // stmt seq → { markedAt, note } (vikendi)
const BANK_EMAILS_SENT_FILE = join(ROOT, 'libro-bank-emails-sent.json'); // stmt filename → { at, to, method }
const TX_OVERRIDES_FILE = join(ROOT, 'libro-tx-overrides.json'); // TX ref → { matchedInvoicePath, method, confidence, reason }
const INVOICE_DATES_FILE = join(ROOT, 'libro-invoice-dates.json'); // invoice path → { date, extractedAt, source: 'ai' | 'manual' }

// ═══════════════════════════════════════════════════════════
// MJESEC MAPPING
// ═══════════════════════════════════════════════════════════
const MONTHS_MAP = {
  // English 3-letter
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  // Croatian 3-letter (with diacritics normalized)
  sij: '01', vel: '02', ozu: '03', tra: '04', svi: '05', lip: '06',
  srp: '07', kol: '08', ruj: '09', lis: '10', stu: '11', pro: '12',
};

function normalizeMonth(mmm) {
  return String(mmm || '').toLowerCase()
    .replace(/ž/g, 'z').replace(/š/g, 's').replace(/č/g, 'c')
    .replace(/ć/g, 'c').replace(/đ/g, 'd')
    .substring(0, 3);
}

function periodFromFolderName(folderName) {
  // "Placanje Apr 26" → "2026-04"
  const m = String(folderName || '').match(/Placanje\s+(\w+)\s+(\d+)/i);
  if (!m) return null;
  const mmm = normalizeMonth(m[1]);
  const yy = m[2].length === 2 ? ('20' + m[2]) : m[2];
  if (!MONTHS_MAP[mmm]) return null;
  return yy + '-' + MONTHS_MAP[mmm];
}

// ═══════════════════════════════════════════════════════════
// RAČUNI — prolazak kroz Invoice 2026/ folder
// ═══════════════════════════════════════════════════════════
async function indexInvoices() {
  const invoices = [];
  if (!existsSync(INVOICE_DIR)) return invoices;

  async function walk(dir, depth = 0, supplierHint = '', periodHint = '') {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;        // .DS_Store itd.
      if (e.name === 'untitled folder') continue;  // prazne pomoćne mape
      // Arhivni folderi — sadrze NE-invoice dokumente (ugovori, potvrde, kalendari).
      // Preskaceemo da ih libro ne pita "čeka slanje".
      if (e.isDirectory() && /^_arhiva/i.test(e.name)) continue;

      const p = join(dir, e.name);

      if (e.isDirectory()) {
        // Hijerarhija očekujemo: Invoice 2026 / Placanje MMM YY / SUPPLIER / files
        let newPeriod = periodHint;
        let newSupplier = supplierHint;

        if (depth === 0) {
          // Invoice 2026/Placanje Apr 26
          const detected = periodFromFolderName(e.name);
          if (detected) newPeriod = detected;
        } else if (depth === 1) {
          // Invoice 2026/Placanje Apr 26/Tesla
          newSupplier = e.name;
        } else {
          // dublje — koristi parent supplier
          newSupplier = supplierHint || e.name;
        }
        await walk(p, depth + 1, newSupplier, newPeriod);
      } else if (e.isFile()) {
        const ext = extname(e.name).toLowerCase();
        if (!/^\.(pdf|jpg|jpeg|png)$/.test(ext)) continue;

        const st = await stat(p);
        const period = periodHint || periodFromFolderName(dir) || '';
        const supplier = supplierHint || basename(dir) || 'Unknown';

        invoices.push({
          path: relative(ROOT, p),
          filename: e.name,
          supplier: supplier,
          period: period,
          year: period ? period.substring(0, 4) : String(new Date().getFullYear()),
          sizeBytes: st.size,
          modifiedAt: st.mtime.toISOString(),
          createdAt: st.birthtime.toISOString(),
        });
      }
    }
  }

  await walk(INVOICE_DIR);
  return invoices;
}

// ═══════════════════════════════════════════════════════════
// IZVODI — HPB camt.053 XML parser (regex-based, bez dep-a)
// ═══════════════════════════════════════════════════════════
function parseCamt053(xml) {
  if (!/<BkToCstmrStmt\b/.test(xml)) return null;

  const ibanMatch = xml.match(/<Acct>[\s\S]*?<IBAN>([^<]+)<\/IBAN>/);
  const iban = ibanMatch ? ibanMatch[1].trim() : '';
  const ccyMatch = xml.match(/<Acct>[\s\S]*?<Ccy>([^<]+)<\/Ccy>/);
  const currency = ccyMatch ? ccyMatch[1].trim() : 'EUR';
  const lglMatch = xml.match(/<LglSeqNb>([^<]+)<\/LglSeqNb>/);
  const lglSeqNb = lglMatch ? lglMatch[1].trim() : '';
  const msgIdMatch = xml.match(/<MsgId>([^<]+)<\/MsgId>/);
  const stmtId = msgIdMatch ? msgIdMatch[1].trim() : (iban + '-' + lglSeqNb);

  const transactions = [];
  const ntryRe = /<Ntry>([\s\S]*?)<\/Ntry>/g;
  let m;
  while ((m = ntryRe.exec(xml)) !== null) {
    const block = m[1];

    const amtMatch = block.match(/<Amt[^>]*>([\d.]+)<\/Amt>/);
    const amount = amtMatch ? Number(amtMatch[1]) : 0;
    const indMatch = block.match(/<CdtDbtInd>([^<]+)<\/CdtDbtInd>/);
    const direction = (indMatch && indMatch[1].trim() === 'DBIT') ? 'OUT' : 'IN';

    const bookMatch = block.match(/<BookgDt>\s*<Dt>([^<]+)<\/Dt>\s*<\/BookgDt>/);
    const bookDate = bookMatch ? bookMatch[1].trim() : '';
    const valMatch = block.match(/<ValDt>\s*<Dt>([^<]+)<\/Dt>\s*<\/ValDt>/);
    const valueDate = valMatch ? valMatch[1].trim() : '';

    const refMatch = block.match(/<AcctSvcrRef>([^<]+)<\/AcctSvcrRef>/);
    const ref = refMatch ? refMatch[1].trim() : '';

    let counterparty = '';
    if (direction === 'OUT') {
      const cdtrMatch = block.match(/<Cdtr>\s*<Pty>[\s\S]*?<Nm>([^<]+)<\/Nm>/);
      counterparty = cdtrMatch ? cdtrMatch[1].trim() : '';
    } else {
      const dbtrMatch = block.match(/<Dbtr>\s*<Pty>[\s\S]*?<Nm>([^<]+)<\/Nm>/);
      counterparty = dbtrMatch ? dbtrMatch[1].trim() : '';
    }

    const addtlMatch = block.match(/<AddtlRmtInf>([^<]+)<\/AddtlRmtInf>/);
    const ustrdMatch = block.match(/<Ustrd>([^<]+)<\/Ustrd>/);
    const description = addtlMatch ? addtlMatch[1].trim()
                      : ustrdMatch ? ustrdMatch[1].trim() : '';

    transactions.push({
      bookDate, valueDate, direction, amount, currency,
      counterparty, description, ref,
    });
  }

  return { iban, currency, stmtId, lglSeqNb, transactions };
}

// Curve merchant extractor (za CRV* transakcije)
const CURVE_CATALOG = [
  [/ARTLIST/i, 'Artlist'],
  [/OPENAI|CHATGPT/i, 'OpenAI / ChatGPT'],
  [/ANTHROPIC|CLAUDE/i, 'Anthropic (Claude)'],
  [/Google\s*ADS/i, 'Google Ads'],
  [/Google\s*YOU|YOUTUBE/i, 'YouTube Premium'],
  [/Google\s*CLOUD/i, 'Google Cloud'],
  [/Google\s*WORKSPACE/i, 'Google Workspace'],
  [/Google\s*ONE/i, 'Google One'],
  [/COOKIEYES/i, 'Cookieyes'],
  [/IKEA/i, 'IKEA'],
  [/MICROSOFT/i, 'Microsoft Store'],
  [/LINKEDIN/i, 'LinkedIn'],
  [/NETLIFY/i, 'Netlify'],
  [/X[\s-]?SENSE/i, 'X-Sense'],
  [/GODADDY/i, 'GoDaddy'],
  [/WPENGINE|WP\s*ENGINE/i, 'WP Engine'],
  [/NESPRESSO/i, 'Nespresso'],
  [/RAILWAY/i, 'Railway'],
  [/ZENROWS/i, 'ZenRows'],
  [/APPLEKING/i, 'AppleKing'],
  [/APPLE/i, 'Apple'],
  [/STRIPE/i, 'Stripe'],
  [/INSTAGRAM|META\s*PLATFORMS/i, 'Instagram Ads'],
  [/FACEBOOK/i, 'Facebook Ads'],
  [/PEVEX/i, 'Pevex'],
  [/WALLAPOP/i, 'Wallapop'],
  [/VERCEL/i, 'Vercel'],
  [/SUPABASE/i, 'Supabase'],
  [/GITHUB/i, 'GitHub'],
  [/NOTION/i, 'Notion'],
  [/FIGMA/i, 'Figma'],
  [/SLACK/i, 'Slack'],
  [/DROPBOX/i, 'Dropbox'],
  [/LINEAR/i, 'Linear'],
  [/PIXELMATOR/i, 'Pixelmator'],
  [/SPOTIFY/i, 'Spotify'],
  [/NETFLIX/i, 'Netflix'],
  [/HBO/i, 'HBO Max'],
  [/DISNEY/i, 'Disney+'],
  [/GOPAY/i, 'GoPay'],
  [/PAYPAL/i, 'PayPal'],
  [/ZALANDO/i, 'Zalando'],
  [/AMAZON/i, 'Amazon'],
  [/ALIEXPRESS/i, 'AliExpress'],
  [/TEMU/i, 'Temu'],
  [/BOOKING/i, 'Booking.com'],
  [/AIRBNB/i, 'Airbnb'],
  [/UPWORK/i, 'Upwork'],
  [/LOCKEDIN/i, 'LockedIn AI'],
  [/SHOP\.FRANCK|FRANCK/i, 'Franck'],
  [/CANVA/i, 'Canva'],
  [/CLOUDFLARE/i, 'Cloudflare'],
  [/AWS|AMAZONWEB/i, 'AWS'],
  [/MALL/i, 'Mall.hr'],
  [/INO|OMV|TIFON|LUKOIL|CRODUX|PETROL/i, 'Benzin'],
  [/PARKING/i, 'Parking'],
];

function extractMerchant(description) {
  const d = String(description || '');
  // HPB card transactions imaju prefix "4059" + merchant
  // Format: 4059CRV*XXXX (Curve) ili 4059MERCHANT*XXX ili 4059Merchant Xxx
  const isCardTx = /^4059/.test(d) || /CRV\*/.test(d);
  if (!isCardTx) return null;

  for (const [re, name] of CURVE_CATALOG) {
    if (re.test(d)) return name;
  }

  // Curve fallback
  const curveMatch = d.match(/CRV\*(.+?)L?Curve\.com/);
  if (curveMatch) {
    return curveMatch[1].replace(/\*/g, ' ').replace(/^\d+\s*/, '').replace(/\s+/g, ' ').trim();
  }

  // Generic card fallback: "4059MERCHANT*..." ili "4059 Merchant ..."
  const cardMatch = d.match(/^4059([A-Za-z][A-Za-z\s*._-]{2,30})/);
  if (cardMatch) {
    return cardMatch[1].replace(/\*/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 30);
  }

  return null;
}

/**
 * Detektiraj gap-ove u bankovnim izvodima po sekvenci brojeva.
 * Tipičan camt.053 format: `<accountNumber>.YYYYNNN.xml` gdje NNN je sekvencijalni broj.
 * Gap se identificira usporedbom s prethodnom i sljedećom sekvencom.
 * Za svaki missing seq vraćamo približni datum (interpolacijom) + Gmail search link.
 */
function detectStatementGaps(xmlFilenames) {
  const seqs = xmlFilenames
    .map(n => {
      const m = n.match(/\.(\d{4})(\d{3})\.xml$/);
      return m ? { year: m[1], seq: parseInt(m[2], 10), file: n } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.seq - b.seq);

  if (seqs.length < 2) return [];

  const gaps = [];
  for (let i = 0; i < seqs.length - 1; i++) {
    const cur = seqs[i];
    const nxt = seqs[i + 1];
    const diff = nxt.seq - cur.seq;
    if (diff <= 1) continue;

    // Gap između cur.seq i nxt.seq
    const _acctNum = (getConfig().bank.accountNumber || '').replace(/[^0-9]/g, '') || '';
    for (let missingSeq = cur.seq + 1; missingSeq < nxt.seq; missingSeq++) {
      const _prefix = _acctNum || (cur.file || '').match(/^(\d+)\./)?.[1] || '';
      gaps.push({
        seq: missingSeq,
        seqFormatted: String(missingSeq).padStart(3, '0'),
        year: cur.year,
        expectedFilename: _prefix
          ? `${_prefix}.${cur.year}${String(missingSeq).padStart(3, '0')}.xml`
          : `seq-${cur.year}${String(missingSeq).padStart(3, '0')}.xml`,
        // Ne znamo točan datum — napomena za UI
        prevSeq: cur.seq,
        prevFile: cur.file,
        nextSeq: nxt.seq,
        nextFile: nxt.file,
      });
    }
  }
  return gaps;
}

async function parseAllStatements() {
  const results = [];
  const fileDateMap = {};  // filename → FrDtTm date (for gap detection)
  if (!existsSync(BANK_DIR)) return { transactions: results, fileDateMap };
  const entries = await readdir(BANK_DIR);
  for (const name of entries) {
    if (!name.endsWith('.xml')) continue;
    const p = join(BANK_DIR, name);
    try {
      const xml = await readFile(p, 'utf8');
      const parsed = parseCamt053(xml);
      if (!parsed) continue;

      // Extract statement date (period FROM) for gap detection
      const frMatch = xml.match(/<FrDtTm>(\d{4}-\d{2}-\d{2})/);
      if (frMatch) fileDateMap[name] = frMatch[1];

      parsed.transactions.forEach(tx => {
        const merchant = extractMerchant(tx.description);
        results.push({
          ...tx,
          merchant: merchant || '',
          displayName: merchant || tx.counterparty || tx.description.substring(0, 40),
          stmtFile: name,
          stmtId: parsed.stmtId,
          iban: parsed.iban,
        });
      });
    } catch (e) {
      console.warn(`⚠ parse fail ${name}: ${e.message}`);
    }
  }
  return { transactions: results, fileDateMap };
}

// ═══════════════════════════════════════════════════════════
// MATCHING — transakcije ↔ računi
// ═══════════════════════════════════════════════════════════
function normalizeToken(s) {
  return String(s || '').toLowerCase()
    .replace(/ž/g, 'z').replace(/š/g, 's').replace(/č/g, 'c')
    .replace(/ć/g, 'c').replace(/đ/g, 'd');
}

// Stop-words koji su PREVIŠE generički da budu match signal
// (com/eu/hr je domena, jan-dec su mjeseci, 2024-2026 godine itd.)
const STOP_TOKENS = new Set([
  // Generic invoice keywords (svi prefiksi koji se mogu pojaviti u opisu transakcija)
  'racun', 'racu', 'invoice', 'receipt', 'pdf', 'placanje', 'placa', 'plac',
  'ostalo', 'untitled', 'potvrda', 'uplate', 'uplata', 'scanned', 'document',
  'manual', 'upload', 'invoice_no', 'receipt_no', 'inv', 'rac', 'doc',
  // Marino-self (privatne uplate sebi nisu poslovni rashod, ne smiju matchat invoice-e)
  'marino', 'marin', 'glazar', 'glaz', 'glazara',
  // Porez / socijalna / banka naknade
  'porez', 'porezi', 'porezna', 'uprava', 'doprinos', 'doprinosa', 'doprin',
  'dopr', 'mirovinsko', 'mirovinska', 'mirov', 'osig', 'osigur', 'osiguranje',
  'hzzo', 'hzz', 'staros', 'starost', 'temelj', 'temelju',
  'drzavni', 'proracun', 'republika', 'republike', 'fina',
  'naknada', 'naknade', 'karticn', 'karticno', 'kartica', 'kartice',
  // TLDs / domains
  'com', 'org', 'net', 'eu', 'hr', 'co', 'io', 'app', 'dev',
  // Months (en/hr) — često u filename-ima i u TX opisima
  'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
  'sij', 'vel', 'ozu', 'tra', 'svi', 'lip', 'srp', 'kol', 'ruj', 'lis', 'stu', 'pro',
  'januar', 'februar', 'mart', 'travanj', 'svibanj', 'lipanj', 'srpanj',
  // Years
  '2022', '2023', '2024', '2025', '2026', '2027',
  // HPB / generic banking words u TX opisima
  'hrvatska', 'postanska', 'banka', 'curve', 'crv', 'francicurve',
  // Geo (često u "SAN FRANCISCO" itd. u Curve TX-u)
  'san', 'london', 'amsterdam', 'dublin', 'mountain', 'usa', 'gbr', 'irl',
]);

// Auto-ignore patterns — counterparty (ili merchant za Curve) match → status IGNORED.
// TX-ovi koji NIKAD ne trebaju invoice (porezi, socijalna, privatne uplate sebi).
const AUTO_IGNORE_COUNTERPARTY_PATTERNS = [
  // Porezi i socijalna
  /^drzavni\s*proracun/i,
  /^porezna\s*uprava/i,
  /^hzzo\b/i,
  /^hzz\b/i,
  /^hrvatski\s*zavod\s*za\s*zdravstv/i,
  /\bdopr(\.|inos)?\s*za\b/i,    // "DOPR.ZA MIROV.OSIG..."
  /\bdoprinos/i,
  /\bmirovinsko\b/i,
  /\bmirov\.?\s*osig/i,
  // Privatne uplate Marinu sebi (sa svog poslovnog na osobni račun)
  /^marino\s*glaz?ar/i,
  /^glaz?ar\s*marino/i,
];

// HPB-specific (only kad je counterparty HPB I description nije Curve transit)
function isHpbBankFee(counterparty, description) {
  const cp = String(counterparty || '');
  const desc = String(description || '');
  if (!/^hrvatska\s*postanska\s*banka/i.test(cp)) return false;
  // Curve i karticna plaćanja prolaze kroz HPB ali su LEGITIMAN trošak — pattern: 4059 ili CRV*
  if (/^4059|CRV\*/i.test(desc)) return false;
  return true;  // pravi HPB fee (provizija, naknada, kamata)
}

function shouldAutoIgnoreCounterparty(tx) {
  // Za Curve TX-ove (description starts with 4059), provjeri merchant — to je stvarna druga strana
  const desc = String(tx.description || '');
  const isCurve = /^4059|CRV\*/i.test(desc);
  const subjectRaw = isCurve
    ? (tx.merchant || tx.displayName || tx.counterparty || '')
    : (tx.counterparty || tx.displayName || '');
  if (!subjectRaw) return false;
  // Normaliziraj dijakritike (DRŽAVNI → drzavni, GLAŽAR → glazar) prije pattern match-a
  const subject = normalizeToken(subjectRaw);
  if (AUTO_IGNORE_COUNTERPARTY_PATTERNS.some(re => re.test(subject))) return true;
  if (isHpbBankFee(tx.counterparty, desc)) return true;
  return false;
}

function tokensFromSupplier(s) {
  const tokens = new Set();
  const raw = normalizeToken(s);
  // Split na whitespace → duži "word" tokeni (≥3)
  raw.split(/[^a-z0-9\-]+/).filter(Boolean).forEach(t => {
    const cleaned = t.replace(/^[-]+|[-]+$/g, '');  // trim leading/trailing "-"
    if (!cleaned) return;
    if (STOP_TOKENS.has(cleaned)) return;
    // Word tokeni ≥3 chars + sadrže slovo (ne samo brojeve)
    if (cleaned.length >= 3 && /[a-z]/.test(cleaned)) tokens.add(cleaned);
    // Invoice broj pattern "19-1-1"
    if (/^\d+(-\d+)*$/.test(cleaned) && cleaned.length >= 3) tokens.add(cleaned);
    // Dugi numerički ID-evi (≥4 znaka)
    if (/^\d{4,}$/.test(cleaned)) tokens.add(cleaned);
  });
  // Compound number pattern "19-1-1" direkt iz raw stringa
  const compoundRe = /\b(\d+(?:-\d+){1,})\b/g;
  let m;
  while ((m = compoundRe.exec(raw)) !== null) {
    tokens.add(m[1]);
  }
  // Dugi digit ID-evi (≥6 chars) — invoice brojevi tipa "260003408049"
  // I bilo gdje gdje se pojavljuju, ne samo cijela riječ (npr. "REG260003408049")
  const longDigitInRawRe = /(\d{6,})/g;
  while ((m = longDigitInRawRe.exec(raw)) !== null) {
    tokens.add(m[1]);
  }
  return [...tokens];
}

async function loadAnnotations() {
  const out = { forwarded: {}, ignored: {}, emailsSent: {}, invoiceMetadata: {}, txOverrides: {} };
  try {
    if (existsSync(FORWARDED_FILE)) {
      out.forwarded = JSON.parse(await readFile(FORWARDED_FILE, 'utf8'));
    }
  } catch (_) { /* ignore bad JSON */ }
  try {
    if (existsSync(IGNORED_FILE)) {
      out.ignored = JSON.parse(await readFile(IGNORED_FILE, 'utf8'));
    }
  } catch (_) { /* ignore bad JSON */ }
  try {
    if (existsSync(EMAILS_SENT_FILE)) {
      out.emailsSent = JSON.parse(await readFile(EMAILS_SENT_FILE, 'utf8'));
    }
  } catch (_) { /* ignore bad JSON */ }
  try {
    if (existsSync(INVOICE_METADATA_FILE)) {
      out.invoiceMetadata = JSON.parse(await readFile(INVOICE_METADATA_FILE, 'utf8'));
    }
  } catch (_) { /* ignore bad JSON */ }
  try {
    if (existsSync(TX_OVERRIDES_FILE)) {
      out.txOverrides = JSON.parse(await readFile(TX_OVERRIDES_FILE, 'utf8'));
    }
  } catch (_) { /* ignore bad JSON */ }
  try {
    if (existsSync(INVOICE_DATES_FILE)) {
      out.invoiceDates = JSON.parse(await readFile(INVOICE_DATES_FILE, 'utf8'));
    }
  } catch (_) { /* ignore bad JSON */ }
  if (!out.invoiceDates) out.invoiceDates = {};
  return out;
}

function matchTransactions(transactions, invoices, annotations) {
  annotations = annotations || { forwarded: {}, ignored: {} };
  // Track koliko puta se pojedini invoice fajl već iskoristio za match
  // (sprječava 1 invoice na N TX-ova kad svaki TX treba svoj račun)
  const invoiceUseCount = {};
  // Predkompajliraj invoice keyword bags
  const invoiceBags = invoices.map(inv => {
    const stem = inv.filename.replace(/\.[^.]+$/, '');
    // Ako je supplier "Ostalo" / "untitled folder", ignoriraj ga i oslanjaj
    // se samo na filename
    const supplierClean = /^(Ostalo|untitled|Nepoznato|Manual)/i.test(inv.supplier)
      ? ''
      : inv.supplier;
    const bag = new Set([
      ...tokensFromSupplier(supplierClean),
      ...tokensFromSupplier(stem),
      // Ukloni ekstenziju i generički prefiks kao "Invoice_No " da ostane broj
      ...tokensFromSupplier(stem.replace(/^(Invoice[_\s-]*No|Receipt|Racun[_\s-]*br\.?|Scanned\s*Document)/i, '').trim()),
    ]);
    return { inv, bag, period: inv.period, stem: stem };
  });

  return transactions.map(tx => {
    if (tx.direction !== 'OUT') return { ...tx, status: 'INCOMING' };

    // Najprije provjeri user annotations (forwarded / ignored imaju prednost nad auto-matchingom)
    const fwdEntry = tx.ref && annotations.forwarded[tx.ref];
    if (fwdEntry) {
      return {
        ...tx,
        status: 'FORWARDED',
        forwardedAt: fwdEntry.at,
        forwardedNote: fwdEntry.note || '',
      };
    }
    const ignEntry = tx.ref && annotations.ignored[tx.ref];
    if (ignEntry) {
      return {
        ...tx,
        status: 'IGNORED',
        ignoredAt: ignEntry.at,
        ignoredNote: ignEntry.note || '',
      };
    }

    // Auto-ignore za TX-ove koji NIKAD ne zahtijevaju invoice
    // (porezi, socijalna, banka naknade, privatne uplate sebi)
    if (shouldAutoIgnoreCounterparty(tx)) {
      return {
        ...tx,
        status: 'IGNORED',
        ignoredAt: null,
        ignoredNote: 'auto: porez/socijalna/naknada/privatno',
        autoIgnored: true,
      };
    }

    // AI / manual override (libro-tx-overrides.json) — force match na specifičan PDF
    // Priority: nakon ignore/forwarded, prije fuzzy match-a
    const ovrEntry = tx.ref && annotations.txOverrides[tx.ref];
    if (ovrEntry && ovrEntry.matchedInvoicePath) {
      const ovrInv = invoices.find(i => i.path === ovrEntry.matchedInvoicePath);
      if (ovrInv) {
        invoiceUseCount[ovrInv.path] = (invoiceUseCount[ovrInv.path] || 0) + 1;
        return {
          ...tx,
          status: 'MATCHED',
          matchReason: ovrEntry.method === 'ai-suggested' ? 'ai' : 'manual',
          aiMatched: ovrEntry.method === 'ai-suggested',
          aiConfidence: ovrEntry.confidence || null,
          aiReason: ovrEntry.reason || '',
          matchedInvoice: {
            path: ovrInv.path,
            filename: ovrInv.filename,
            supplier: ovrInv.supplier,
            period: ovrInv.period,
          },
        };
      }
    }

    const txMonth = String(tx.bookDate || '').substring(0, 7);
    const rawText = (tx.description || '') + ' ' + (tx.counterparty || '') + ' ' + (tx.merchant || '');
    const searchText = normalizeToken(rawText);
    if (!searchText) return { ...tx, status: 'MISSING' };

    // Extract invoice-number patterns iz opisa transakcije
    //   1) "19-1-1", "17-1-1" — compound brojevi (poziv na broj)
    //   2) "260003408049" — dugi digit ID (najmanje 6 znamenki)
    const txNumbers = new Set();
    const compoundNumRe = /\b(\d+(?:-\d+){1,})\b/g;
    let nm;
    while ((nm = compoundNumRe.exec(searchText)) !== null) {
      if (nm[1].length >= 3) txNumbers.add(nm[1]);
    }
    const longDigitRe = /\b(\d{6,})\b/g;
    while ((nm = longDigitRe.exec(searchText)) !== null) {
      txNumbers.add(nm[1]);
    }

    // Match algoritam s prioritizacijom signala (jaki → slabi):
    //   1. Invoice broj pattern u opisu ("19-1-1") match-a token u bagu
    //   2. Supplier folder name (npr. "Netlify") direkt u TX text-u
    //   3. Bilo koji word token (3+ chars) iz invoice-a u TX text-u (fallback)
    // Pretražimo SVE invoice-e sa svakim signalom, vrati prvi match jačeg signala.
    let best = null;
    let bestReason = '';

    // Filter invoice-e na compatibilan period (±1 mjesec)
    const candidates = invoiceBags.filter(({ period }) => {
      if (!txMonth || !period) return true;
      return Math.abs(monthsBetween(txMonth, period)) <= 1;
    });

    // Two-pass strategija:
    //   Pass 1: traži match na NEISKORIŠTENI invoice (1:1 preferiran)
    //   Pass 2: ako Pass 1 ne nađe, dozvoli reuse (recurring suppliers tipa Apple)
    // Ovako CookieYes-ovi različiti TX-ovi s istim iznosom traže različite invoice-e,
    // a Apple iCloud i Apple Arcade mogu match-at i isti generic Apple invoice
    // ako jedan od njih nije specifičnije match-an.
    const unusedCandidates = candidates.filter(({ inv }) => !invoiceUseCount[inv.path]);

    // Helper: try matching against given candidate list
    const trySignals = (list) => {
      // Signal 1: invoice broj match
      for (const { inv, bag } of list) {
        for (const num of txNumbers) {
          if (bag.has(num)) return { inv, reason: 'invoice#:' + num };
        }
      }
      // Signal 2: supplier folder name u TX text-u
      for (const { inv } of list) {
        const supplierNorm = normalizeToken(inv.supplier);
        if (supplierNorm.length < 2) continue;
        if (STOP_TOKENS.has(supplierNorm)) continue;
        const supTokens = supplierNorm.split(/[^a-z0-9]+/).filter(t => {
          if (!t || STOP_TOKENS.has(t)) return false;
          if (t.length >= 4) return true;
          if (t.length >= 2 && /[a-z]/.test(t) && /\d/.test(t)) return true;
          return false;
        });
        for (const st of supTokens) {
          let matches;
          if (st.length <= 3) {
            const re = new RegExp('\\b' + st.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
            matches = re.test(searchText);
          } else {
            matches = searchText.includes(st);
          }
          if (matches) return { inv, reason: 'supplier:' + st };
        }
      }
      // Signal 3: bilo koji ne-stop word token iz invoice baga
      for (const { inv, bag } of list) {
        for (const t of bag) {
          if (t.length < 4) continue;
          if (/^\d+(-\d+)*$/.test(t)) continue;
          if (STOP_TOKENS.has(t)) continue;
          if (searchText.includes(t)) return { inv, reason: 'keyword:' + t };
        }
      }
      return null;
    };

    // Pass 1: pokušaj na NEISKORIŠTENE invoice-e (preferiran 1:1 match)
    let result = trySignals(unusedCandidates);
    let isReused = false;
    // Pass 2: ako Pass 1 ne nađe, dozvoli reuse (recurring tipa Apple/Google)
    if (!result) {
      result = trySignals(candidates);
      isReused = !!result;
    }
    if (result) {
      best = result.inv;
      bestReason = result.reason + (isReused ? ' (reused)' : '');
    }

    if (best) {
      invoiceUseCount[best.path] = (invoiceUseCount[best.path] || 0) + 1;
    }

    return {
      ...tx,
      status: best ? 'MATCHED' : 'MISSING',
      matchReason: bestReason,
      matchedInvoice: best ? {
        path: best.path,
        filename: best.filename,
        supplier: best.supplier,
        period: best.period,
      } : null,
      isReusedMatch: isReused,  // true ako match koristi već iskorišten invoice
    };
  });
}

function monthsBetween(a, b) {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return (ay - by) * 12 + (am - bm);
}

/**
 * Generira "placeholder invoice" zapise — virtuelni redak za svaki TX gdje fali PDF
 * (MISSING ili reused match). Dashboard ih prikazuje pored stvarnih invoice-a, klikom
 * se otvara upload modal pre-popunjen s tx datumom/iznosom/supplier-om.
 */
function generatePlaceholders(matched) {
  const placeholders = [];
  matched.forEach(tx => {
    if (tx.direction !== 'OUT') return;
    if (tx.status === 'IGNORED' || tx.status === 'FORWARDED') return;
    const needsOwnInvoice = tx.status === 'MISSING' || tx.isReusedMatch;
    if (!needsOwnInvoice) return;

    let supplier = tx.merchant || '';
    if (!supplier && tx.counterparty && !/^HRVATSKA POSTANSKA BANKA/i.test(tx.counterparty)) {
      supplier = tx.counterparty;
    }
    if (!supplier) supplier = tx.displayName || 'Unknown';

    placeholders.push({
      id: 'ph_' + (tx.ref || tx.bookDate + '_' + tx.amount),
      txRef: tx.ref,
      supplier: supplier,
      displayName: tx.displayName || supplier,
      expectedAmount: tx.amount,
      currency: tx.currency || 'EUR',
      bookDate: tx.bookDate,
      valueDate: tx.valueDate,
      period: (tx.bookDate || '').substring(0, 7),
      year: (tx.bookDate || '').substring(0, 4) || String(new Date().getFullYear()),
      description: tx.description,
      stmtFile: tx.stmtFile,
      reason: tx.status === 'MISSING' ? 'no-match' : 'reused-match',
      currentMatch: tx.matchedInvoice ? {
        path: tx.matchedInvoice.path,
        filename: tx.matchedInvoice.filename,
      } : null,
    });
  });
  placeholders.sort((a, b) => (b.bookDate || '').localeCompare(a.bookDate || ''));
  return placeholders;
}

// ═══════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════
async function main() {
  console.log('▸ libro local processor');
  console.log(`  root: ${ROOT}`);
  console.log(`  year: ${YEAR}`);

  console.log(`\n▸ ${basename(INVOICE_DIR)}/ index…`);
  const invoices = await indexInvoices();
  console.log(`  ✓ ${invoices.length} invoice fajlova`);
  const perMonth = {};
  invoices.forEach(i => { perMonth[i.period || '—'] = (perMonth[i.period || '—'] || 0) + 1; });
  Object.keys(perMonth).sort().forEach(m => console.log(`     ${m}: ${perMonth[m]}`));

  console.log(`\n▸ ${basename(BANK_DIR)}/ XML parsing…`);
  const { transactions: allTx, fileDateMap } = await parseAllStatements();
  console.log(`  ✓ ${allTx.length} transakcija iz ${new Set(allTx.map(t => t.stmtFile)).size} izvoda`);

  // Učitaj popis izvoda koje je user označio "HPB nije slao"
  let notSentStmts = {};
  try {
    if (existsSync(NOT_SENT_STMTS_FILE)) {
      notSentStmts = JSON.parse(await readFile(NOT_SENT_STMTS_FILE, 'utf8'));
    }
  } catch (_) { /* noop */ }

  // Učitaj evidenciju bank email slanja (user je pokrenuo Pošalji knjigovodstvu)
  let bankEmailsSent = {};
  try {
    if (existsSync(BANK_EMAILS_SENT_FILE)) {
      bankEmailsSent = JSON.parse(await readFile(BANK_EMAILS_SENT_FILE, 'utf8'));
    }
  } catch (_) { /* noop */ }

  // Filenames popis za dalje (stmt lista + gap detekcija)
  const stmtFilenames = Object.keys(fileDateMap);

  // Sastavi popis SVIH bank statements s email sent statusom
  const statements = stmtFilenames
    .map(fname => {
      const seqMatch = fname.match(/\.(\d{4})(\d{3})\.xml$/);
      const seq = seqMatch ? parseInt(seqMatch[2], 10) : 0;
      const pdfName = fname.replace(/\.xml$/i, '.pdf');
      const pdfPath = join(BANK_DIR, pdfName);
      const xmlEntry = bankEmailsSent[fname];
      const pdfEntry = bankEmailsSent[pdfName];
      const sent = !!(xmlEntry || pdfEntry);
      const entry = xmlEntry || pdfEntry;
      return {
        xmlFile: fname,
        pdfFile: existsSync(pdfPath) ? pdfName : '',
        seq: seq,
        seqFormatted: String(seq).padStart(3, '0'),
        date: fileDateMap[fname] || '',
        emailSent: sent,
        emailSentAt: entry ? entry.at : '',
        emailSentTo: entry ? entry.to : '',
      };
    })
    .sort((a, b) => b.seq - a.seq);  // najnoviji prvo

  // Detect gaps in bank statement sequences (074, 075, 076... missing?)
  const gapSeqsRaw = detectStatementGaps(stmtFilenames);
  const gapSeqs = gapSeqsRaw.filter(g => !notSentStmts[g.seqFormatted]);
  const missingStatements = gapSeqs.map(gap => {
    const prevDate = fileDateMap[gap.prevFile] || '';
    const nextDate = fileDateMap[gap.nextFile] || '';
    // Estimate date: if only 1 missing between N and N+2, likely single business day
    // Otherwise use date range
    const seqDiff = gap.nextSeq - gap.prevSeq;  // total gap incl. endpoints
    const relativeOffset = gap.seq - gap.prevSeq;  // where in gap this one is
    let estimatedDate = '';
    if (prevDate && nextDate) {
      const p = new Date(prevDate);
      const n = new Date(nextDate);
      const totalDays = (n - p) / 86400000;
      const offsetDays = Math.round(totalDays * (relativeOffset / seqDiff));
      const est = new Date(p.getTime() + offsetDays * 86400000);
      estimatedDate = est.toISOString().slice(0, 10);
    }
    // Gmail search URL — finds bank statement email for this date
    const _bankSender = getConfig().bank.statementSenderEmail || '';
    const _fromClause = _bankSender ? `from:${_bankSender}` : 'subject:Izvod';
    const dateForGmail = estimatedDate ? estimatedDate.replace(/-/g, '/') : '';
    const gmailQuery = dateForGmail && _bankSender
      ? `${_fromClause} "${estimatedDate.split('-').reverse().join('.')}"`
      : `${_fromClause} subject:Izvod`;
    return {
      seq: gap.seq,
      seqFormatted: gap.seqFormatted,
      expectedFilename: gap.expectedFilename,
      estimatedDate: estimatedDate,
      prevDate: prevDate,
      nextDate: nextDate,
      gmailUrl: 'https://mail.google.com/mail/u/0/#search/' + encodeURIComponent(gmailQuery),
    };
  });
  if (missingStatements.length) {
    console.log(`  ⚠ Fali ${missingStatements.length} izvod(a) u ${basename(BANK_DIR)}/:`);
    missingStatements.forEach(m => {
      console.log(`     seq ${m.seqFormatted} · ~${m.estimatedDate} · ${m.expectedFilename}`);
    });
  }

  console.log('\n▸ Matching transakcije → računi…');
  const annotations = await loadAnnotations();

  // Dodaj email-sent status na svaki invoice (ključ: relativni path)
  const emailsSent = annotations.emailsSent || {};
  const invoiceMetadata = annotations.invoiceMetadata || {};
  const invoiceDates = annotations.invoiceDates || {};
  invoices.forEach(inv => {
    const entry = emailsSent[inv.path];
    if (entry) {
      inv.emailSent = true;
      inv.emailSentAt = entry.at || '';
      inv.emailSentTo = entry.to || '';
    }
    const meta = invoiceMetadata[inv.path];
    if (meta) {
      if (meta.sourceUrl) inv.sourceUrl = meta.sourceUrl;
      if (meta.notes) inv.notes = meta.notes;
    }
    const dateEntry = invoiceDates[inv.path];
    if (dateEntry && dateEntry.date) {
      inv.invoiceDate = dateEntry.date;     // ISO date "2026-04-13"
      inv.invoiceDateSource = dateEntry.source || 'ai';
    }
  });
  const fwdCount = Object.keys(annotations.forwarded).length;
  const ignCount = Object.keys(annotations.ignored).length;
  if (fwdCount) console.log(`  ⚐ forwarded annotations: ${fwdCount}`);
  if (ignCount) console.log(`  ⊘ ignored annotations: ${ignCount}`);

  const matched = matchTransactions(allTx, invoices, annotations);

  // Detektiraj recurring suppliers koji dijele invoice (vjerojatno fale dodatni PDF-ovi)
  const reusedByInvoice = {};
  matched.filter(t => t.isReusedMatch && t.matchedInvoice).forEach(t => {
    const k = t.matchedInvoice.path;
    if (!reusedByInvoice[k]) {
      reusedByInvoice[k] = {
        invoicePath: k,
        supplier: t.matchedInvoice.supplier,
        filename: t.matchedInvoice.filename,
        txList: [],
      };
    }
    reusedByInvoice[k].txList.push({
      bookDate: t.bookDate,
      amount: t.amount,
      ref: t.ref,
      description: (t.description || '').substring(0, 60),
    });
  });
  const needsMoreInvoices = Object.values(reusedByInvoice).filter(g => g.txList.length >= 1);
  // Filter — uključi samo ako je sumnjivo (≥1 reused = bar 2 TX dijele isti invoice)

  const stats = {
    total: matched.length,
    matched: matched.filter(t => t.status === 'MATCHED').length,
    forwarded: matched.filter(t => t.status === 'FORWARDED').length,
    ignored: matched.filter(t => t.status === 'IGNORED').length,
    missing: matched.filter(t => t.status === 'MISSING').length,
    incoming: matched.filter(t => t.status === 'INCOMING').length,
    reused: matched.filter(t => t.isReusedMatch).length,
    invoicesEmailSent: invoices.filter(i => i.emailSent).length,
    invoicesNotEmailed: invoices.filter(i => !i.emailSent).length,
  };
  console.log(`  ✓ matched: ${stats.matched}`);
  console.log(`  📧 forwarded (iz Gmaila): ${stats.forwarded}`);
  console.log(`  ⊘ ignored: ${stats.ignored}`);
  console.log(`  ✗ missing: ${stats.missing}`);
  console.log(`  ◐ incoming: ${stats.incoming}`);

  // Missing list by merchant
  const missingByMerchant = {};
  matched.filter(t => t.status === 'MISSING').forEach(t => {
    const key = t.displayName || t.counterparty || 'Nepoznato';
    missingByMerchant[key] = (missingByMerchant[key] || 0) + 1;
  });
  const topMissing = Object.entries(missingByMerchant).sort((a, b) => b[1] - a[1]).slice(0, 15);
  if (topMissing.length) {
    console.log('\n  Top missing:');
    topMissing.forEach(([name, count]) => console.log(`    · ${count}x  ${name}`));
  }

  // Sorted by bookDate desc
  matched.sort((a, b) => (b.bookDate || '').localeCompare(a.bookDate || ''));
  invoices.sort((a, b) => (b.modifiedAt || '').localeCompare(a.modifiedAt || ''));

  const data = {
    generatedAt: new Date().toISOString(),
    year: YEAR,
    stats: stats,
    invoices: invoices,
    transactions: matched,
    statements: statements,
    missingStatements: missingStatements,
    needsMoreInvoices: needsMoreInvoices,
    placeholderInvoices: generatePlaceholders(matched),
    summary: {
      invoiceCount: invoices.length,
      statementCount: new Set(allTx.map(t => t.stmtFile)).size,
      transactionCount: matched.length,
      matched: stats.matched,
      forwarded: stats.forwarded,
      ignored: stats.ignored,
      missing: stats.missing,
      incoming: stats.incoming,
      missingStatementsCount: missingStatements.length,
      statementsEmailSent: statements.filter(s => s.emailSent).length,
      statementsEmailPending: statements.filter(s => !s.emailSent).length,
    },
  };

  await writeFile(OUT_FILE, JSON.stringify(data, null, 2), 'utf8');
  console.log(`\n✓ Output → ${relative(ROOT, OUT_FILE)} (${Math.round((await stat(OUT_FILE)).size / 1024)} KB)`);
}

main().catch(err => { console.error(err); process.exit(1); });
