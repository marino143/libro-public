# Architecture — libro. local stack

## Overview

**libro.** je dashboard za osobno računovodstvo. Tri ključne komponente:

1. **Frontend** — single HTML file s inline CSS + JS (no build tool)
2. **Node server** — serve static + API endpoints (no framework, native `http`)
3. **Node processor** — skenira foldere, parsira XML, output JSON (no DB)

**Data ne postoji u memoriji.** Sve je file-based:
- Input: `Invoice 2026/*.pdf`, `IZVODI CO 2026/*.xml`, `libro-*.json` annotations
- Output: `libro-data.json` koji dashboard čita

**Nikakav OAuth, API key, cloud service.** Jedina mrežna komponenta je localhost:8765.

---

## Flow: upload PDF invoice

```
User: drop PDF via + Račun button
  │
  ▼
Dashboard: fetch('/api/upload', {kind: INVOICE, fileBase64, supplier, period, ...})
  │
  ▼
libro-server.mjs: handleUpload()
  │ 1. Decode base64 → Buffer
  │ 2. Determine target dir: Invoice 2026/Placanje MMM YY/Supplier/
  │ 3. mkdir -p + writeFile
  │ 4. spawn('node', ['local-libro.mjs'], {detached:true}) — auto rebuild
  │ 5. Return { success, path, duplicate, ... }
  │
  ▼
Dashboard: po success → setTimeout(loadLocalData, 2000) → UI refresh
```

## Flow: rebuild

```
Trigger: auto po uploadu, ili POST /api/rebuild, ili CLI `node local-libro.mjs`
  │
  ▼
local-libro.mjs main():
  │ 1. indexInvoices()
  │    · walk Invoice 2026/ recursively
  │    · parse "Placanje MMM YY" folder names → period
  │    · use parent folder as supplier
  │ 2. parseAllStatements()
  │    · readdir IZVODI CO 2026/*.xml
  │    · regex parse HPB camt.053 (no XML lib)
  │    · extract 187 tx across 56 XMLs
  │ 3. loadAnnotations()
  │    · libro-forwarded.json (TX marked as sent from Gmail)
  │    · libro-ignored.json (TX to ignore — fees, taxes)
  │    · libro-emails-sent.json (invoices marked as sent to accountant)
  │ 4. matchTransactions()
  │    · for each OUT tx:
  │      · if ref in forwarded → status = FORWARDED
  │      · else if ref in ignored → status = IGNORED
  │      · else try invoice# match (description → "19-1-1")
  │      · else try keyword match (invoice supplier tokens)
  │      · else MISSING
  │    · IN tx → INCOMING
  │ 5. Decorate invoices with emailSent state
  │ 6. writeFile libro-data.json
```

## Flow: display transactions

```
User: klikne "Transakcije" nav item
  │
  ▼
Dashboard: switchView('transactions')
  │
  ▼
loadTransactions():
  │ 1. if LIBRO_LOCAL_DATA — mapiraj t.status formate
  │ 2. renderTxStats() — 5 cards + nav count
  │ 3. renderTxList() — grid rows + banner + bulk actions
```

---

## Files

### `libro-server.mjs` (~350 lines)

ESM module, native Node `http`. Key functions:
- `createServer(...)` — main router
- `handleUpload(req, res)` — POST /api/upload
- `handleForwardMark(req, res)` — POST /api/forward-mark
- `handleIgnore(req, res)` — POST /api/ignore
- `handleMarkInvoiceEmailSent(req, res)` — POST /api/mark-email-sent
- `handleSendInvoiceEmail(req, res)` — POST /api/send-invoice-email (AppleScript → Mail.app)
- `handleTravelOrder(req, res)` — POST /api/travel-order
- `handleTravelOrdersList(req, res)` — GET /api/travel-orders
- `handleRebuild(req, res)` — POST /api/rebuild (sync, vraća log)
- `handleOpen(req, res)` — POST /api/open (spawn `open` macOS command)
- `serveStatic(req, res, url)` — GET /* static file serve

**CORS:** Access-Control-Allow-Origin: * (jer samo localhost, neće se deployati).
**Path safety:** `safeJoin()` onemogućuje `../` traversals izvan ROOT.

### `local-libro.mjs` (~500 lines)

ESM module, native Node `fs/promises`. Key functions:
- `indexInvoices()` — walk, tokenize, produce invoice list
- `parseCamt053(xml)` — regex parser (no xml lib)
- `parseAllStatements()` — produce transaction list
- `extractMerchant(description)` — Curve CRV* catalog (~60 merchants)
- `matchTransactions(tx, invoices, annotations)` — 2-stage match (invoice# → keyword)
- `tokensFromSupplier(str)` — strip stop-words, preserve compound numbers
- `loadAnnotations()` — read all 3 JSON annotation files
- `main()` — orchestration + write libro-data.json

### `racunovodstvo-dashboard.html` (~4900 lines)

Single HTML file. Kolumn:
- Lines ~1-1450: CSS + nav HTML
- Lines ~1450-2100: view sections (inbox, outgoing, outgoing-history, transactions, travel, settings, accounting-docs)
- Lines ~2100-2150: detail panels (right column)
- Lines ~2150-4500: `<script>` logic
- Lines ~4500-end: global modals (upload, bank upload, diagnostics, send instructions)

**No framework.** Vanilla JS + direct DOM manipulation. Custom `fmtDate`, `escHtml`, `tnFmtEur` utilities.

Data fetched once on init, re-fetched after mutations:
```js
loadLocalData() → LIBRO_LOCAL_DATA = …
  → renderTxStats()
  → renderTxList()
  → refreshCounts()
  → updateDataSourceBadge()
```

---

## Key design decisions

### Why no database?
File-based je jednostavnije za single-user setup. JSON annotations se rebuilda svaki put (brzo, 187 tx + 171 invoice = <1s).

### Why no backend framework?
Native `http` je dosta za 5-6 endpointa. Nema build-step, nema node_modules (OK, samo `fs`, `http`, `path`, `child_process`).

### Why XML regex (not xml lib)?
HPB camt.053 format je stabilan. Regex brži, čitljiviji. Fallback na `XmlService` u Apps Scriptu bio je problem (namespace discovery).

### Why single-file HTML?
- Drag&drop deploy
- Nema build step
- Nema state sync problema između modula
- Može se open-directly bez servera (kao fallback mockup demo)

### Why local instead of cloud?
- Privatnost: financijski dokumenti ne idu nigdje
- Brzina: instant rebuild bez network RTT-a
- Pouzdanost: no Apps Script timeouts, no Gmail API quotas
- Google Drive sync ionako sinkronizira folder automatski

### Why annotations u zasebnim JSON-ovima?
- `libro-data.json` se regenira iz izvora (folder scan + XML parse). Annotations su user input, ne smiju se izgubiti pri rebuildu.
- 3 file-a zato što su 3 različita koncepta: TX forwarded (bez PDF-a), TX ignored, Invoice email sent.

---

## Data invariants

- `libro-data.json.summary.transactionCount === count(libro-data.json.transactions)`
- Za svaki tx s `status=MATCHED` → `tx.matchedInvoice.path` mora biti u `libro-data.json.invoices[].path`
- Za svaki tx s `status=FORWARDED` → `tx.ref in libro-forwarded.json`
- Za svaki invoice s `emailSent=true` → `invoice.path in libro-emails-sent.json`

Ako libro-data.json ikad ne slaže s annotations → rebuild popravlja.

---

## Performance

- Invoice index: ~170 files, walk + stat = **~200ms**
- XML parse: 56 files × ~5KB = **~300ms**
- Match: 187 tx × 170 invoice = 32k comparisons = **~50ms**
- Total rebuild: **~500-800ms** (dominantno I/O)
- JSON write: 190KB = **~10ms**

Nema razloga za optimizaciju osim ako lista naraste na 1000+ invoice-a.

---

## Security posture

- **Lokalni server** — slušanje samo na localhost (0.0.0.0 prihvaća, ali firewall obično blokira izvana)
- **No auth** — jer samo user može pristupati Mac-u
- **Path traversal defense** — `safeJoin()` sprječava `../` izlazak iz ROOT-a
- **No SQL injection** — nema DB-a
- **No XSS** — `escHtml()` svuda gdje se injecta user input u HTML

**Ne deploy-aj** ovo na cloud bez auth. To je personal tool.

---

## External dependencies

**Nula npm paketa.** Sve iz Node standard library.

macOS integracija:
- `open` command (handleOpen — open PDF u Preview)
- `osascript` (AppleScript za Mail.app compose + attachment)

Ako se preseli na Linux/Windows — `handleOpen` treba alt (xdg-open, start) + `handleSendInvoiceEmail` treba alt (thunderbird, mailto fallback).
