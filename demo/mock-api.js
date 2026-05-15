// ═══════════════════════════════════════════════════════════════════════════
// libro DEMO · mock /api/* layer
// ────────────────────────────────────────────────────────────────────────────
// Intercept-a fetch() i XMLHttpRequest za sve /api/* rute, vraća pre-baked
// JSON podatke iz libro-config.json / libro-data.json. Pisanje (POST) ne
// modificira ništa — samo vraća success bez side-effecta.
// ═══════════════════════════════════════════════════════════════════════════

(function() {
  'use strict';

  // ── Cache za demo podatke ──
  let _config = null;
  let _data = null;

  function loadSync(url) {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, false);
    try {
      xhr.send(null);
      if (xhr.status === 200) return JSON.parse(xhr.responseText);
    } catch (_) {}
    return null;
  }

  function getConfig() {
    if (_config) return _config;
    _config = loadSync('libro-config.json') || {
      version: 1, setupCompleted: true,
      supplier: {}, folders: {}, ai: {}, accounting: {}, bank: {}, gmail: {}, ui: { currency: 'EUR' }
    };
    return _config;
  }

  function getData() {
    if (_data) return _data;
    _data = loadSync('libro-data.json') || { summary: {}, invoices: [], transactions: [], statements: [] };
    return _data;
  }

  // ── Mock responses ──
  function ok(payload) {
    return { status: 200, json: payload };
  }
  function notFound(msg) {
    return { status: 404, json: { error: msg || 'Not found in demo mode' } };
  }
  function demoNoop(label) {
    showDemoToast('Demo: ' + label + ' (simulirano)');
    return { status: 200, json: { success: true, demo: true, message: label + ' simulated' } };
  }

  function showDemoToast(msg) {
    try {
      if (typeof window.showToast === 'function') {
        window.showToast(msg);
        return;
      }
    } catch (_) {}
    // Fallback DOM toast
    let t = document.getElementById('demo-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'demo-toast';
      t.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#1a1a1a;color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;z-index:99999;box-shadow:0 4px 12px rgba(0,0,0,0.3);opacity:0;transition:opacity 0.2s;';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._h);
    t._h = setTimeout(() => { t.style.opacity = '0'; }, 2500);
  }

  function route(method, path, body) {
    method = method.toUpperCase();
    const url = new URL(path, 'http://demo');
    const p = url.pathname;
    const qs = url.searchParams;

    // ── First-run / config ─────────────────────────────────────────────
    if (p === '/api/setup-status') return ok({ firstRun: false, setupCompleted: true });
    if (p === '/api/config' && method === 'GET') return ok(getConfig());
    if (p === '/api/config' && method === 'POST') {
      // Demo: ne snimi, samo simulira
      const updates = body ? JSON.parse(body) : {};
      return ok({ success: true, demo: true, config: { ...getConfig(), ...(updates.config || updates) }, setupCompleted: true });
    }
    if (p === '/api/status') return ok({ ok: true, demo: true, port: 0, time: new Date().toISOString() });

    // ── Read-only data ─────────────────────────────────────────────────
    if (p === '/api/claude/usage') return ok({
      enabled: true, dailyUsdSpent: 0.47, dailyLimitUsd: 2,
      monthly: { totalCalls: 142, totalUsd: 8.92, byOp: { 'parse-pdf': 5.21, 'chat': 2.18, 'parse-outgoing-pdf': 1.53 } }
    });
    if (p === '/api/storage-stats') {
      const d = getData();
      return ok({
        success: true,
        year: d.year || '2026',
        totalBytes: 4_521_600,
        totalFiles: (d.invoices || []).length + (d.statements || []).length * 2,
        sizeStr: '4.4 MB',
        monthsSpan: 4
      });
    }
    if (p === '/api/clients/list') return ok({
      success: true,
      clients: [
        { name: 'TechCorp d.o.o.', taxId: 'HR98765432101', address: 'Avenija Dubrovnik 16, 10000 Zagreb', country: 'HR', email: 'finance@techcorp.example' },
        { name: 'Beta Labs Ltd', taxId: 'GB123456789', address: '221B Baker St, London NW1 6XE', country: 'GB', email: 'ap@betalabs.example' },
        { name: 'Gamma Ventures LLC', taxId: 'US12-3456789', address: '500 Market St, San Francisco, CA 94103', country: 'US', email: 'invoices@gammavc.example' }
      ]
    });
    if (p === '/api/accountant/emails') return ok({
      success: true, threads: [],
      cached: true,
      message: 'Demo: knjigovođa email feed (sinkronizirano iz Gmaila u produkciji).'
    });
    if (p === '/api/accountant-docs') return ok({
      success: true,
      items: [
        { filename: 'PDV_04-2026.pdf', path: 'Knjigovodstvo dokumenti/PDV_04-2026.pdf', sizeBytes: 186000, modifiedAt: '2026-04-21T10:00:00Z', mimeType: 'application/pdf', ext: 'pdf', category: 'Mjesečni', notes: '', uploadedAt: '2026-04-21T10:00:00Z' },
        { filename: 'JOPPD_04-2026.xml', path: 'Knjigovodstvo dokumenti/JOPPD_04-2026.xml', sizeBytes: 42000, modifiedAt: '2026-04-21T10:00:00Z', mimeType: 'application/xml', ext: 'xml', category: 'Mjesečni', notes: 'Mirovinska — trajno', uploadedAt: '2026-04-21T10:00:00Z' },
        { filename: 'GFI-POD_2025.pdf', path: 'Knjigovodstvo dokumenti/GFI-POD_2025.pdf', sizeBytes: 412000, modifiedAt: '2026-04-25T10:00:00Z', mimeType: 'application/pdf', ext: 'pdf', category: 'Godišnji', notes: '', uploadedAt: '2026-04-25T10:00:00Z' }
      ]
    });
    if (p === '/api/reminders') {
      if (method === 'GET') return ok({ success: true, reminders: [] });
      return demoNoop('Sprema reminder');
    }
    if (p === '/api/travel-orders') return ok({ success: true, orders: [] });
    if (p === '/api/outgoing-old') return ok({
      success: true, year: '2026',
      items: [
        { path: 'Izlazni racuni 2026/_uploaded_old/RCN-2026-08.pdf', filename: 'RCN-2026-08.pdf', invoiceNumber: '2026-08', customer: 'TechCorp d.o.o.', total: 4500, currency: 'EUR', issueDate: '2026-04-18', sizeBytes: 89000 },
        { path: 'Izlazni racuni 2026/_uploaded_old/RCN-2026-07.pdf', filename: 'RCN-2026-07.pdf', invoiceNumber: '2026-07', customer: 'Beta Labs Ltd', total: 3200, currency: 'EUR', issueDate: '2026-03-25', sizeBytes: 84000 },
        { path: 'Izlazni racuni 2026/_uploaded_old/RCN-2026-05.pdf', filename: 'RCN-2026-05.pdf', invoiceNumber: '2026-05', customer: 'Gamma Ventures LLC', total: 1800, currency: 'EUR', issueDate: '2026-02-22', sizeBytes: 81000 }
      ]
    });
    if (p === '/api/outgoing-arhiva') return ok({ success: true, items: [] });

    // ── Demo libro-data.json (dashboard ovo direktno fetch-a) ──────────
    if (p === '/libro-data.json') return ok(getData());
    if (p === '/libro-config.json') return ok(getConfig());

    // ── Write / mutate ops — sve su no-op u demo modu ─────────────────
    const writeRoutes = {
      '/api/upload': 'Upload PDF-a',
      '/api/rebuild': 'Rebuild libro-data.json',
      '/api/ignore': 'Označi TX kao ignored',
      '/api/open': 'Otvori file u Finder-u',
      '/api/forward-mark': 'Označi TX kao forwarded',
      '/api/send-invoice-email': 'Slanje invoice emaila',
      '/api/mark-email-sent': 'Označi email poslan',
      '/api/invoice-metadata': 'Sprema metadata',
      '/api/statement-not-sent': 'Označi statement',
      '/api/send-statement-email': 'Slanje statement emaila',
      '/api/mark-statement-email-sent': 'Označi statement email',
      '/api/check-mail-rule': 'Provjera Mail.app rule',
      '/api/claude/parse-pdf': 'AI parse PDF',
      '/api/claude/parse-outgoing-pdf': 'AI parse outgoing PDF',
      '/api/claude/chat': 'AI chat',
      '/api/claude/extract-invoice-date': 'AI extract datuma',
      '/api/clients/save': 'Spremi klijenta',
      '/api/clients/delete': 'Obriši klijenta',
      '/api/clients/dedupe': 'Dedupe klijenata',
      '/api/move-to-bank': 'Premjesti u bank folder',
      '/api/scan-misclassified-banks': 'Skeniraj misclassified',
      '/api/sync-missing-statements': 'Sync missing izvoda',
      '/api/hpb-auto-process': 'Auto-process inbox',
      '/api/hpb-archive-all-inbox': 'Archive inbox',
      '/api/ai-match-missing': 'AI match missing',
      '/api/invoice-date-set': 'Postavi datum invoice',
      '/api/accountant/download': 'Download attachment',
      '/api/accountant/ai-categorize': 'AI kategorizacija',
      '/api/outgoing-old/upload': 'Upload starog računa',
      '/api/outgoing-old/ai-parse': 'AI parse starog računa',
      '/api/outgoing-old/edit': 'Edit starog računa',
      '/api/outgoing-old/delete': 'Brisanje starog računa',
      '/api/outgoing-arhiva/restore': 'Restore arhiva',
      '/api/accountant-docs/upload': 'Upload dokumenta',
      '/api/outgoing-invoice/send': 'Slanje izlaznog računa',
      '/api/travel-order': 'Sprema putni nalog',
      '/api/travel-order/send': 'Slanje putnog naloga',
      '/api/travel-order/ai-report': 'AI putni izvještaj',
      '/api/travel-order/delete': 'Brisanje putnog naloga'
    };

    if (writeRoutes[p]) {
      // Specijalni: AI chat vraća pre-baked odgovor
      if (p === '/api/claude/chat') {
        const userMsg = body ? (JSON.parse(body).messages || []).slice(-1)[0]?.content || '' : '';
        return ok({
          content: [{ type: 'text', text: 'Ovo je demo odgovor. U produkciji bi Claude analizirao tvoje libro-data.json i odgovorio na: "' + String(userMsg).slice(0, 80) + '". Demo data: Acme Studio · 18 računa · ~31 transakcija · 4 mjeseca podataka.' }],
          usage: { input_tokens: 250, output_tokens: 80 },
          cost_usd: 0.0012
        });
      }
      if (p === '/api/travel-order/ai-report') {
        return ok({
          success: true,
          report: {
            aktivnosti: 'Demo aktivnosti — sastanak s klijentom i tehnička prezentacija novog releasea.',
            rezultati: 'Klijent potvrdio narudžbu za sljedeću fazu; usuglašen vremenski okvir.',
            zakljucak: 'Putovanje uspješno, ciljevi postignuti.'
          },
          cost_usd: 0.003
        });
      }
      return demoNoop(writeRoutes[p]);
    }

    return notFound(p);
  }

  // ── Intercept fetch() ──
  const _origFetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = (init && init.method) || (typeof input === 'object' && input.method) || 'GET';
    if (url.startsWith('/api/') || url === '/libro-data.json' || url === '/libro-config.json') {
      const body = init && init.body;
      const r = route(method, url, typeof body === 'string' ? body : null);
      return Promise.resolve(new Response(JSON.stringify(r.json), {
        status: r.status,
        headers: { 'Content-Type': 'application/json' }
      }));
    }
    return _origFetch(input, init);
  };

  // ── Intercept XMLHttpRequest (za sync calls u bootstrap-u) ──
  const _origOpen = XMLHttpRequest.prototype.open;
  const _origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this._demoMethod = method;
    this._demoUrl = url;
    if (typeof url === 'string' && (url.startsWith('/api/') || url === '/libro-data.json' || url === '/libro-config.json')) {
      this._demoIntercept = true;
      return; // ne zovi origOpen
    }
    return _origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
    if (this._demoIntercept) {
      const r = route(this._demoMethod, this._demoUrl, typeof body === 'string' ? body : null);
      Object.defineProperty(this, 'status', { value: r.status, configurable: true });
      Object.defineProperty(this, 'readyState', { value: 4, configurable: true });
      Object.defineProperty(this, 'responseText', { value: JSON.stringify(r.json), configurable: true });
      if (this.onreadystatechange) this.onreadystatechange();
      if (this.onload) this.onload();
      return;
    }
    return _origSend.apply(this, arguments);
  };

  // ── Mark global da kod zna da je demo ──
  window.LIBRO_DEMO_MODE = true;
  console.log('[libro DEMO] mock /api/* layer aktivan. Sve mutate ops su no-op.');
})();
