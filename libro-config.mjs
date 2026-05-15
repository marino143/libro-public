// ═══════════════════════════════════════════════════════════════════════════
//  libro-config — central config loader
//  ────────────────────────────────────────────────────────────────────────
//  Učitava `libro-config.json` (user config) i merge-a s default schemom iz
//  `libro-config.example.json`. Drugi moduli (libro-server, local-libro, ...)
//  zovu getConfig() umjesto da hardkodiraju vrijednosti.
//
//  First-run experience: ako `libro-config.json` ne postoji ili
//  `setupCompleted === false`, vraćamo defaults i isFirstRun() vraća true.
//  Server u tom slučaju serve-a setup wizard umjesto dashboarda.
// ═══════════════════════════════════════════════════════════════════════════

import { readFile, writeFile } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const CONFIG_FILE = join(ROOT, 'libro-config.json');
const EXAMPLE_FILE = join(ROOT, 'libro-config.example.json');

let _cache = null;
let _cacheTime = 0;
const CACHE_TTL_MS = 2000;

function loadDefaults() {
  try {
    return JSON.parse(readFileSync(EXAMPLE_FILE, 'utf8'));
  } catch (e) {
    console.warn('⚠ libro-config.example.json missing or invalid — using inline defaults');
    return {
      version: 1,
      setupCompleted: false,
      supplier: { name: '', oib: '', country: 'HR', address: '', city: '', postalCode: '', email: '', website: '', iban: '', swift: '', bank: '' },
      folders: { root: '', incomingInvoices: 'Invoice {year}', bankStatements: 'Izvodi {year}', outgoingInvoices: 'Izlazni racuni {year}', accountantDocs: 'Knjigovodstvo dokumenti' },
      ai: { enabled: false, provider: 'anthropic', model: 'claude-sonnet-4-5', dailyLimitUSD: 2 },
      accounting: { enabled: false, primaryEmail: '', secondaryEmails: [], eRacuniInbox: '', autoForwardBankStatements: false },
      bank: { parser: 'auto', name: '', accountNumber: '', statementSenderEmail: '' },
      gmail: { enabled: false, primaryAccount: '', secondaryAccount: '' },
      ui: { appName: 'libro', locale: 'hr', currency: 'EUR', defaultYear: null }
    };
  }
}

function deepMerge(target, source) {
  if (!source || typeof source !== 'object') return target;
  const out = Array.isArray(target) ? [...target] : { ...target };
  for (const key of Object.keys(source)) {
    const a = out[key];
    const b = source[key];
    if (b && typeof b === 'object' && !Array.isArray(b) && a && typeof a === 'object' && !Array.isArray(a)) {
      out[key] = deepMerge(a, b);
    } else if (b !== undefined) {
      out[key] = b;
    }
  }
  return out;
}

export function getConfig({ fresh = false } = {}) {
  if (!fresh && _cache && Date.now() - _cacheTime < CACHE_TTL_MS) return _cache;
  const defaults = loadDefaults();
  let user = {};
  if (existsSync(CONFIG_FILE)) {
    try {
      user = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    } catch (e) {
      console.warn('⚠ libro-config.json parse error: ' + e.message);
    }
  }
  _cache = deepMerge(defaults, user);
  _cacheTime = Date.now();
  return _cache;
}

export function isFirstRun() {
  const cfg = getConfig({ fresh: true });
  return !existsSync(CONFIG_FILE) || cfg.setupCompleted !== true;
}

export async function saveConfig(updates, { markComplete = false } = {}) {
  const current = getConfig({ fresh: true });
  const next = deepMerge(current, updates);
  if (markComplete) next.setupCompleted = true;
  await writeFile(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  _cache = null;
  return next;
}

// ───────────────────────────────────────────────────────────
// Path resolvers — koriste config umjesto hardkodiranih foldera
// ───────────────────────────────────────────────────────────
export function resolveFolderName(template, year) {
  if (!template) return '';
  return String(template).replace(/\{year\}/g, String(year));
}

export function folderPath(kind, year, configOverride = null) {
  const cfg = configOverride || getConfig();
  const root = cfg.folders.root || ROOT;
  const y = year || cfg.ui.defaultYear || new Date().getFullYear();
  const template = cfg.folders[kind] || '';
  const name = resolveFolderName(template, y);
  return name ? join(root, name) : root;
}

export function defaultYear() {
  const cfg = getConfig();
  return cfg.ui.defaultYear || new Date().getFullYear();
}

// ───────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────
export function isAIEnabled() {
  return !!getConfig().ai.enabled;
}

export function isAccountingEnabled() {
  return !!getConfig().accounting.enabled;
}

export function isGmailEnabled() {
  return !!getConfig().gmail.enabled;
}

export function getAccountantEmails() {
  const cfg = getConfig();
  if (!cfg.accounting.enabled) return [];
  const list = [];
  if (cfg.accounting.primaryEmail) list.push(cfg.accounting.primaryEmail);
  if (Array.isArray(cfg.accounting.secondaryEmails)) list.push(...cfg.accounting.secondaryEmails);
  return list.filter(Boolean);
}

export function getDefaultRecipient() {
  const cfg = getConfig();
  return cfg.accounting.eRacuniInbox || cfg.accounting.primaryEmail || '';
}

export function getSupplier() {
  return { ...getConfig().supplier };
}
