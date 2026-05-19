// ═══════════════════════════════════════════════════════════════════════════
// libro · i18n — minimal locale switcher
// ────────────────────────────────────────────────────────────────────────────
// Usage:
//   <script src="i18n.js"></script>   ← prije svega ostalog
//   <span data-i18n="nav.all">Sve</span>
//   <input data-i18n-placeholder="form.email" placeholder="...">
//
// Supported keys:
//   data-i18n             → textContent
//   data-i18n-placeholder → placeholder attribute
//   data-i18n-title       → title attribute
//   data-i18n-aria        → aria-label attribute
//   data-i18n-html        → innerHTML (samo za trusted content!)
//
// Active locale je perzistiran u localStorage.libro.locale.
// Default: HR (može override-ati setupConfig.ui.locale).
// ═══════════════════════════════════════════════════════════════════════════

(function() {
  'use strict';

  const STORAGE_KEY = 'libro.locale';
  const DEFAULT = 'hr';

  // ── Dict ──
  const DICT = {
    hr: {
      // Brand
      'brand.tagline': 'osobno računovodstvo',
      'brand.title.dashboard': 'libro · računovodstvo',
      'brand.title.setup': 'libro · setup',
      'brand.title.demo': 'libro · demo',

      // Locale switcher
      'locale.toggle': 'EN',
      'locale.label': 'Jezik',

      // Sidebar nav — sections
      'nav.section.incoming': 'Dolazno',
      'nav.section.outgoing': 'Izlazno',
      'nav.section.personal': 'Osobno',
      'nav.section.archive': 'Arhiva',

      // Sidebar nav — items
      'nav.all': 'Sve',
      'nav.missing-pdf': 'Fali PDF račun',
      'nav.pending-send': 'Čeka slanje',
      'nav.invoices': 'Računi',
      'nav.accountant': 'Knjigovodstvo',
      'nav.new-outgoing': 'Novi izlazni račun',
      'nav.sent-invoices': 'Poslani računi',
      'nav.travel-order': 'Putni nalog',
      'nav.reminders': 'Podsjetnici',
      'nav.forwarded-log': 'Log prosljeđivanja',
      'nav.cloud-folder': 'Cloud folder ↗',
      'nav.settings': 'Postavke',

      // Top tabs (matching status)
      'tab.all': 'Sve',
      'tab.matched': '✓ Matched',
      'tab.forwarded': '📧 Poslano',
      'tab.incoming': '↓ Uplate',
      'tab.ignored': '○ Ignorirano',
      'tab.pending': '→ Čeka slanje',
      'tab.sent': '✓ Poslano',
      'tab.waiting': '◐ Čeka račun',

      // Common buttons
      'btn.refresh': '↻ Osvježi',
      'btn.newest-first': '↓ Najnoviji prvo',
      'btn.bulk-drop': '🐂 Bulk drop',
      'btn.add-invoice': '+ Račun',
      'btn.add-statement': '+ Izvod',
      'btn.rebuild': 'Rebuild',
      'btn.save': 'Spremi',
      'btn.cancel': 'Otkaži',
      'btn.send': 'Pošalji',
      'btn.send-accountant': '→ Pošalji knjigovodstvu',
      'btn.open': 'Otvori',
      'btn.delete': 'Obriši',
      'btn.edit': 'Uredi',
      'btn.back': '← Natrag',
      'btn.skip-later': 'Preskoči — popunit ću kasnije',
      'btn.save-open': 'Spremi i otvori dashboard',

      // Search
      'search.placeholder': 'Traži po pošiljatelju, subjectu ili iznosu…',

      // Stats labels
      'stats.received-monthly': 'PRIMLJENO (MJ.)',
      'stats.sent-monthly': 'POSLANO KNJ. (MJ.)',
      'stats.waiting-invoice': 'ČEKA RAČUN',
      'stats.costs-monthly': 'TROŠKOVI (MJ.)',

      // Demo banner
      'demo.banner': '🎮 <strong>DEMO mode</strong> — sve akcije (Rebuild, Upload, Send Mail, AI Chat) su simulirane · podaci su lažni (codigit d.o.o.) · <a href="https://github.com/marino143/libro-public" target="_blank">izvorni kod ↗</a>',
      'demo.banner.setup': '🎮 <strong>DEMO mode</strong> — wizard je pre-popunjen s codigit d.o.o. podacima · "Spremi" će te odvesti na dashboard · <a href="https://github.com/marino143/libro-public" target="_blank">izvorni kod ↗</a>',
      'demo.pill': '🎮 Demo · codigit d.o.o.',

      // Landing page
      'landing.intro.p1': 'Lokalno osobno računovodstvo. Skenira PDF račune i bankovne izvode iz tvog foldera, matcha uplate s računima, AI parsira nepoznate dokumente, i opcionalno forwardira knjigovođi.',
      'landing.intro.p2': 'Sve ostaje lokalno — folderi na tvom disku, server na localhost-u, AI poziva direktno Anthropic API. Bez SaaS-a, bez čuvanja podataka na tuđim serverima.',
      'landing.cta.dashboard': 'Otvori dashboard →',
      'landing.cta.setup': 'Probaj setup wizard',
      'landing.cta.github': 'GitHub ↗',
      'landing.features.title': 'Što vidiš u demu',
      'landing.f1.title': '📊 Dashboard s lažnim podacima',
      'landing.f1.body': '4 mjeseca podataka za fiktivni "codigit d.o.o." — 18 računa, 31 transakcija, 8 izvoda, 3 klijenta.',
      'landing.f2.title': '🔍 Matching transakcija ↔ računa',
      'landing.f2.body': 'Vidiš kako libro spaja uplate s PDF računima (status: MATCHED / MISSING / IGNORED / INCOMING).',
      'landing.f3.title': '📑 Izlazni računi · putni nalozi',
      'landing.f3.body': 'Forma za generiranje XML/PDF izlaznog računa, klijent autocomplete, putni nalozi.',
      'landing.f4.title': '💬 AI chat (mock)',
      'landing.f4.body': 'U produkciji Claude analizira tvoj libro-data.json. U demu vraća pripremljen odgovor.',
      'landing.f5.title': '⚙️ Setup wizard',
      'landing.f5.body': '5-koraka wizard koji vidi novi korisnik pri prvom pokretanju (folder, firma, AI, knjigovodstvo, banka).',
      'landing.f6.title': '📁 Knjigovodstveni dokumenti',
      'landing.f6.body': 'Arhiva PDV obrazaca, JOPPD, godišnjih izvještaja — sve s retention politikama.',
      'landing.meta': 'Demo je read-only — sve <code>POST</code> akcije (upload, rebuild, send mail) su no-op-i. Za stvarno korištenje: <code>git clone https://github.com/marino143/libro-public</code> → <code>node libro-server.mjs</code> → otvori <code>localhost:8765</code>.<br><br>Vidi <a href="https://github.com/marino143/libro-public#readme" target="_blank">README</a> · <a href="https://github.com/marino143/libro-public/blob/main/SETUP.md" target="_blank">SETUP vodič</a>.',

      // Setup wizard
      'setup.title': 'osobno računovodstvo · setup wizard',
      'setup.step1.title': 'Folder za račune',
      'setup.step1.hint': 'Gdje su PDF-ovi računa i bankovni izvodi? libro skenira ovaj folder.',
      'setup.step1.root': 'Korijenski folder',
      'setup.step1.root.hint': '(apsolutna putanja)',
      'setup.step1.incoming': 'Dolazni računi',
      'setup.step1.incoming.hint': '{year} = godina',
      'setup.step1.bank': 'Bankovni izvodi',
      'setup.step1.outgoing': 'Izlazni računi',
      'setup.step1.accdocs': 'Knjigovodstveni dokumenti',
      'setup.step2.title': 'Tvoji podaci (firma / obrt)',
      'setup.step2.hint': 'Pojavljuju se na izlaznim računima i putnim nalozima. Sve je opcionalno — popuni kad budeš trebao.',
      'setup.step2.name': 'Naziv firme',
      'setup.step2.optional': '(opcionalno)',
      'setup.step2.oib': 'OIB',
      'setup.step2.oib.hint': '(11 znamenki)',
      'setup.step2.address': 'Adresa',
      'setup.step2.city': 'Grad / Poštanski broj',
      'setup.step2.iban': 'IBAN',
      'setup.step2.bank': 'Banka',
      'setup.step2.bank.hint': '(naziv)',
      'setup.step2.email': 'Email',
      'setup.step2.currency': 'Default valuta',
      'setup.step3.title': 'AI (Claude) za automatsku obradu',
      'setup.step3.hint': 'AI parsira PDF račune, ekstrahira datume, matcha uplate s računima, kategorizira dokumente. Opcionalno — bez AI-a libro radi keyword matching.',
      'setup.step3.enable.title': 'Uključi AI obradu',
      'setup.step3.enable.sub': 'Treba Anthropic API key (~5-15 EUR/mj).',
      'setup.step3.key': 'Anthropic API key',
      'setup.step3.model': 'Model',
      'setup.step3.limit': 'Dnevni limit (USD)',
      'setup.step4.title': 'Knjigovodstvo · auto-forward',
      'setup.step4.hint': 'Ako šalješ izvode i račune knjigovođi/e-računi portalu, libro može automatski forwardirati. Default: isključeno.',
      'setup.step4.enable.title': 'Uključi knjigovodstvo flow',
      'setup.step4.enable.sub': '"Pošalji knjigovodstvu" gumbi, auto-forward bank statements, accountant inbox.',
      'setup.step4.primary': 'Primarni email knjigovođe',
      'setup.step4.secondary': 'Sekundarni emaili',
      'setup.step4.secondary.hint': '(odvojeno zarezom — bivši knjigovođe, druga osoba)',
      'setup.step4.eracuni': 'e-Računi inbox',
      'setup.step4.eracuni.hint': '(npr. OIB@e-racuni.com za default recipient)',
      'setup.step5.title': 'Banka · parser izvoda',
      'setup.step5.hint': 'Za sync iz Gmaila i preciznu detekciju izvoda treba znati tvoju banku. Skip ako još ne znaš — kasnije u Settings.',
      'setup.step5.name': 'Naziv banke',
      'setup.step5.account': 'Broj računa',
      'setup.step5.account.hint': '(samo brojevi)',
      'setup.step5.sender': 'Email banke koji šalje izvode',
      'setup.step5.sender.hint': '(npr. kontakt.centar@hpb.hr)',
      'setup.step5.parser': 'Parser',
      'setup.step5.parser.auto': 'Auto (XML camt.053 ako ima, inače AI)',
      'setup.step5.parser.camt': 'SEPA camt.053 XML (HPB, PBZ, Erste, ...)',
      'setup.step5.parser.ai': 'AI (Claude Vision) — bilo koja banka, sporije',

      // Main inbox view — header + month picker
      'inbox.title': 'Inbox',
      'inbox.subtitle': '{newCount} novih stavki · {pendingCount} uplata bez računa (ukupno)',
      'inbox.subtitle.short': '{newCount} novih stavki ovaj mjesec',

      // Pending section ("Čeka se skidanje računa" card)
      'pending.title': 'Čeka se skidanje računa',
      'pending.desc': 'Uplate koje nemaju PDF račun — treba ih ručno skinuti ili arhivirati',
      'pending.badge': 'ČEKA',
      'pending.paid': 'Plaćeno',
      'pending.today': 'danas',
      'pending.days-ago': 'prije {n} dana',
      'pending.days-ago-1': 'prije 1 dan',
      'pending.open-portal': '↗ Otvori portal',
      'pending.done': '✓ Gotovo',

      // Stats labels
      'stats.received': 'Primljeno (mj.)',
      'stats.sent-acc': 'Poslano knj. (mj.)',
      'stats.awaiting': 'Čeka račun',
      'stats.costs': 'Troškovi (mj.)',
      'stats.vs-prev': 'vs. prošli',
      'stats.queued': 'na čekanju',
      'stats.need-send': 'treba poslati',

      // Tabs (additional — extends earlier tab.* keys)
      'tab.invoices': 'Računi',
      'tab.bank': 'Izvodi',
      'tab.accountant': 'Knjigovodstvo',

      // Toolbar buttons
      'btn.refresh-gmail': '↻ Osvježi',
      'btn.refresh-gmail.title': 'Skeniraj Gmail za nove račune (zadnjih 2 dana)',
      'btn.sort-newest': '↓ Najnoviji prvo',
      'btn.sort-oldest': '↑ Najstariji prvo',
      'btn.sort-toggle.title': 'Prebaci sortiranje: najnoviji ↔ najstariji',
      'btn.bulk-drop.title': 'Drop više PDF-ova odjednom — Claude ih sam sortira',
      'btn.add-invoice.short': '+ Račun',
      'btn.add-bank.short': '+ Izvod',

      // List item status badges
      'list.status.invoice': 'RAČUN',
      'list.status.bank': 'IZVOD',
      'list.status.travel': 'PUTNI NALOG',
      'list.status.accountant': 'KNJIG.',
      'list.in-drive': 'DRV',

      // Right detail panel — review / scope
      'detail.review.title': '→ Čeka slanje knjigovodstvu',
      'detail.scope.instruction': 'Označi je li ovaj račun za FIRMU ili PRIVATNO, pa pošalji.',
      'detail.scope.company': 'FIRMA',
      'detail.scope.private': 'PRIVATNO',
      'detail.scope.private-note': 'Privatni računi se ne šalju knjigovodstvu — arhiva je dovoljna.',
      'detail.send-acc': '→ Pošalji knjigovodstvu',
      'detail.forwarded.title': '✓ Poslano knjigovodstvu',
      'detail.notforwarded.title': '◐ PDF je u folderu, ali NIJE poslan knjigovodstvu',
      'detail.notforwarded.body': 'Klikni "📧 Pošalji knjigovodstvu" dolje',

      // Right detail — online location & notes
      'detail.location.title': '🔗 Online lokacija & napomene',
      'detail.location.edit': '✏ Uredi',
      'detail.location.empty': 'Bez URL-a. Klikni ✏ Uredi da dodaš portal link za sljedeći put.',

      // Right detail — attachment & process log
      'detail.attachment.title': 'Prilog · arhiviran',
      'detail.attachment.open': 'Otvori PDF →',
      'detail.process.title': 'Tijek obrade',
      'detail.process.in-folder': 'PDF u folderu',
      'detail.process.not-sent': 'Nije poslano knjigovodstvu (klikni "📧 Pošalji")',

      // Right detail — bottom buttons
      'detail.btn.send-acc': '📧 Pošalji knjigovodstvu',
      'detail.btn.already-sent': '✓ Već poslano',
      'detail.btn.already-sent.title': 'Već sam poslao iz Gmaila ili direktno',
      'detail.btn.open-pdf': '📄 Otvori PDF',
      'detail.btn.resend': '↻ Pošalji ponovo',
      'detail.btn.resend-fwd': '↻ Ponovi prosljeđivanje',
      'detail.btn.unmark': '↶ Nije poslano',
      'detail.btn.unmark.title': 'Skini oznaku poslano',
      'detail.btn.forward-acc': '→ Proslijedi knjigovođi',
      'detail.attachment.open-drive': 'Otvori u Drive →',
      'detail.choose': 'Odaberi stavku',
      'inbox.missing-total': '{count} uplata bez računa (ukupno)',
      // Demo content strings (HR varijanta — service description za pending cards)
      'demo.svc.claude-pro': 'Claude Pro — mjesečna pretplata',

      // Months (full names for header)
      'month.1': 'Siječanj',
      'month.2': 'Veljača',
      'month.3': 'Ožujak',
      'month.4': 'Travanj',
      'month.5': 'Svibanj',
      'month.6': 'Lipanj',
      'month.7': 'Srpanj',
      'month.8': 'Kolovoz',
      'month.9': 'Rujan',
      'month.10': 'Listopad',
      'month.11': 'Studeni',
      'month.12': 'Prosinac',
      'month.1.short': 'sij',
      'month.2.short': 'velj',
      'month.3.short': 'ožu',
      'month.4.short': 'tra',
      'month.5.short': 'svi',
      'month.6.short': 'lip',
      'month.7.short': 'srp',
      'month.8.short': 'kol',
      'month.9.short': 'ruj',
      'month.10.short': 'lis',
      'month.11.short': 'stu',
      'month.12.short': 'pro',
    },
    en: {
      // Brand
      'brand.tagline': 'personal accounting',
      'brand.title.dashboard': 'libro · accounting',
      'brand.title.setup': 'libro · setup',
      'brand.title.demo': 'libro · demo',

      // Locale switcher
      'locale.toggle': 'HR',
      'locale.label': 'Language',

      // Sidebar nav — sections
      'nav.section.incoming': 'Inbox',
      'nav.section.outgoing': 'Outbound',
      'nav.section.personal': 'Personal',
      'nav.section.archive': 'Archive',

      // Sidebar nav — items
      'nav.all': 'All',
      'nav.missing-pdf': 'Missing PDF',
      'nav.pending-send': 'Pending send',
      'nav.invoices': 'Invoices',
      'nav.accountant': 'Accounting',
      'nav.new-outgoing': 'New invoice',
      'nav.sent-invoices': 'Sent invoices',
      'nav.travel-order': 'Travel order',
      'nav.reminders': 'Reminders',
      'nav.forwarded-log': 'Forward log',
      'nav.cloud-folder': 'Cloud folder ↗',
      'nav.settings': 'Settings',

      // Top tabs
      'tab.all': 'All',
      'tab.matched': '✓ Matched',
      'tab.forwarded': '📧 Forwarded',
      'tab.incoming': '↓ Incoming',
      'tab.ignored': '○ Ignored',
      'tab.pending': '→ Pending send',
      'tab.sent': '✓ Sent',
      'tab.waiting': '◐ Awaiting invoice',

      // Common buttons
      'btn.refresh': '↻ Refresh',
      'btn.newest-first': '↓ Newest first',
      'btn.bulk-drop': '🐂 Bulk drop',
      'btn.add-invoice': '+ Invoice',
      'btn.add-statement': '+ Statement',
      'btn.rebuild': 'Rebuild',
      'btn.save': 'Save',
      'btn.cancel': 'Cancel',
      'btn.send': 'Send',
      'btn.send-accountant': '→ Send to accountant',
      'btn.open': 'Open',
      'btn.delete': 'Delete',
      'btn.edit': 'Edit',
      'btn.back': '← Back',
      'btn.skip-later': 'Skip — I\'ll fill in later',
      'btn.save-open': 'Save and open dashboard',

      // Search
      'search.placeholder': 'Search by sender, subject, or amount…',

      // Stats labels
      'stats.received-monthly': 'RECEIVED (MO.)',
      'stats.sent-monthly': 'SENT TO ACC. (MO.)',
      'stats.waiting-invoice': 'AWAITING PDF',
      'stats.costs-monthly': 'COSTS (MO.)',

      // Demo banner
      'demo.banner': '🎮 <strong>DEMO mode</strong> — all actions (Rebuild, Upload, Send Mail, AI Chat) are simulated · data is fake (codigit d.o.o.) · <a href="https://github.com/marino143/libro-public" target="_blank">source code ↗</a>',
      'demo.banner.setup': '🎮 <strong>DEMO mode</strong> — wizard is pre-filled with codigit d.o.o. data · "Save" takes you to the dashboard · <a href="https://github.com/marino143/libro-public" target="_blank">source code ↗</a>',
      'demo.pill': '🎮 Demo · codigit d.o.o.',

      // Landing page
      'landing.intro.p1': 'Local personal accounting. Scans PDF invoices and bank statements from your folder, matches payments to invoices, AI parses unknown documents, and optionally forwards to your accountant.',
      'landing.intro.p2': 'Everything stays local — folders on your disk, server on localhost, AI calls Anthropic directly. No SaaS, no third-party storage.',
      'landing.cta.dashboard': 'Open dashboard →',
      'landing.cta.setup': 'Try the setup wizard',
      'landing.cta.github': 'GitHub ↗',
      'landing.features.title': 'What you see in the demo',
      'landing.f1.title': '📊 Dashboard with fake data',
      'landing.f1.body': '4 months of data for the fictional "codigit d.o.o." — 18 invoices, 31 transactions, 8 statements, 3 clients.',
      'landing.f2.title': '🔍 Transaction ↔ invoice matching',
      'landing.f2.body': 'See how libro pairs bank inflows with PDF invoices (status: MATCHED / MISSING / IGNORED / INCOMING).',
      'landing.f3.title': '📑 Outgoing invoices · travel orders',
      'landing.f3.body': 'Form for generating XML/PDF outgoing invoices, client autocomplete, travel orders.',
      'landing.f4.title': '💬 AI chat (mock)',
      'landing.f4.body': 'In production, Claude analyses your libro-data.json. In the demo, it returns a canned answer.',
      'landing.f5.title': '⚙️ Setup wizard',
      'landing.f5.body': 'First-run wizard new users see (folder, company, AI, accounting, bank). 5 steps.',
      'landing.f6.title': '📁 Accounting documents',
      'landing.f6.body': 'Archive of VAT forms, payroll forms, annual reports — all with retention policies.',
      'landing.meta': 'Demo is read-only — all <code>POST</code> actions (upload, rebuild, send mail) are no-ops. For real use: <code>git clone https://github.com/marino143/libro-public</code> → <code>node libro-server.mjs</code> → open <code>localhost:8765</code>.<br><br>See <a href="https://github.com/marino143/libro-public#readme" target="_blank">README</a> · <a href="https://github.com/marino143/libro-public/blob/main/SETUP.md" target="_blank">SETUP guide</a>.',

      // Setup wizard
      'setup.title': 'personal accounting · setup wizard',
      'setup.step1.title': 'Folder for invoices',
      'setup.step1.hint': 'Where do your invoice PDFs and bank statements live? libro scans this folder.',
      'setup.step1.root': 'Root folder',
      'setup.step1.root.hint': '(absolute path)',
      'setup.step1.incoming': 'Incoming invoices',
      'setup.step1.incoming.hint': '{year} = current year',
      'setup.step1.bank': 'Bank statements',
      'setup.step1.outgoing': 'Outgoing invoices',
      'setup.step1.accdocs': 'Accounting documents',
      'setup.step2.title': 'Your details (company / sole trader)',
      'setup.step2.hint': 'Shown on outgoing invoices and travel orders. All optional — fill in when needed.',
      'setup.step2.name': 'Company name',
      'setup.step2.optional': '(optional)',
      'setup.step2.oib': 'Tax ID (OIB)',
      'setup.step2.oib.hint': '(11 digits in HR)',
      'setup.step2.address': 'Address',
      'setup.step2.city': 'City / Postal code',
      'setup.step2.iban': 'IBAN',
      'setup.step2.bank': 'Bank',
      'setup.step2.bank.hint': '(name)',
      'setup.step2.email': 'Email',
      'setup.step2.currency': 'Default currency',
      'setup.step3.title': 'AI (Claude) for automatic processing',
      'setup.step3.hint': 'AI parses PDF invoices, extracts dates, matches payments to invoices, categorises documents. Optional — without AI, libro uses keyword matching.',
      'setup.step3.enable.title': 'Enable AI processing',
      'setup.step3.enable.sub': 'Requires Anthropic API key (~5-15 EUR/mo).',
      'setup.step3.key': 'Anthropic API key',
      'setup.step3.model': 'Model',
      'setup.step3.limit': 'Daily limit (USD)',
      'setup.step4.title': 'Accounting · auto-forward',
      'setup.step4.hint': 'If you send statements and invoices to an accountant or e-invoicing portal, libro can auto-forward. Default: off.',
      'setup.step4.enable.title': 'Enable accounting flow',
      'setup.step4.enable.sub': '"Send to accountant" buttons, auto-forward bank statements, accountant inbox.',
      'setup.step4.primary': 'Primary accountant email',
      'setup.step4.secondary': 'Secondary emails',
      'setup.step4.secondary.hint': '(comma-separated — previous accountants, second contact)',
      'setup.step4.eracuni': 'e-Invoicing inbox',
      'setup.step4.eracuni.hint': '(e.g. OIB@e-racuni.com for default recipient)',
      'setup.step5.title': 'Bank · statement parser',
      'setup.step5.hint': 'To sync from Gmail and accurately detect statements, libro needs to know your bank. Skip if unsure — fill in later in Settings.',
      'setup.step5.name': 'Bank name',
      'setup.step5.account': 'Account number',
      'setup.step5.account.hint': '(digits only)',
      'setup.step5.sender': 'Bank email that sends statements',
      'setup.step5.sender.hint': '(e.g. statements@your-bank.com)',
      'setup.step5.parser': 'Parser',
      'setup.step5.parser.auto': 'Auto (XML camt.053 if available, else AI)',
      'setup.step5.parser.camt': 'SEPA camt.053 XML (HPB, PBZ, Erste, ...)',
      'setup.step5.parser.ai': 'AI (Claude Vision) — any bank, slower',

      // Main inbox view
      'inbox.title': 'Inbox',
      'inbox.subtitle': '{newCount} new items · {pendingCount} payments without invoice (total)',
      'inbox.subtitle.short': '{newCount} new items this month',

      // Pending section
      'pending.title': 'Waiting for invoice download',
      'pending.desc': 'Payments without a PDF invoice — download or archive manually',
      'pending.badge': 'WAITING',
      'pending.paid': 'Paid',
      'pending.today': 'today',
      'pending.days-ago': '{n} days ago',
      'pending.days-ago-1': '1 day ago',
      'pending.open-portal': '↗ Open portal',
      'pending.done': '✓ Done',

      // Stats labels
      'stats.received': 'Received (mo.)',
      'stats.sent-acc': 'Sent to acc. (mo.)',
      'stats.awaiting': 'Awaiting invoice',
      'stats.costs': 'Costs (mo.)',
      'stats.vs-prev': 'vs. previous',
      'stats.queued': 'queued',
      'stats.need-send': 'need to send',

      // Tabs
      'tab.invoices': 'Invoices',
      'tab.bank': 'Statements',
      'tab.accountant': 'Accounting',

      // Toolbar buttons
      'btn.refresh-gmail': '↻ Refresh',
      'btn.refresh-gmail.title': 'Scan Gmail for new invoices (last 2 days)',
      'btn.sort-newest': '↓ Newest first',
      'btn.sort-oldest': '↑ Oldest first',
      'btn.sort-toggle.title': 'Toggle sort: newest ↔ oldest',
      'btn.bulk-drop.title': 'Drop many PDFs at once — Claude sorts them',
      'btn.add-invoice.short': '+ Invoice',
      'btn.add-bank.short': '+ Statement',

      // List item status badges
      'list.status.invoice': 'INVOICE',
      'list.status.bank': 'STATEMENT',
      'list.status.travel': 'TRAVEL',
      'list.status.accountant': 'ACC.',
      'list.in-drive': 'DRV',

      // Right detail panel — review / scope
      'detail.review.title': '→ Awaiting send to accountant',
      'detail.scope.instruction': 'Mark whether this invoice is for COMPANY or PERSONAL, then send.',
      'detail.scope.company': 'COMPANY',
      'detail.scope.private': 'PERSONAL',
      'detail.scope.private-note': 'Personal invoices are not sent to the accountant — archive is enough.',
      'detail.send-acc': '→ Send to accountant',
      'detail.forwarded.title': '✓ Sent to accountant',
      'detail.notforwarded.title': '◐ PDF is in folder but NOT sent to accountant',
      'detail.notforwarded.body': 'Click "📧 Send to accountant" below',

      // Online location & notes
      'detail.location.title': '🔗 Online location & notes',
      'detail.location.edit': '✏ Edit',
      'detail.location.empty': 'No URL. Click ✏ Edit to add a portal link for next time.',

      // Attachment & process log
      'detail.attachment.title': 'Attachment · archived',
      'detail.attachment.open': 'Open PDF →',
      'detail.process.title': 'Processing log',
      'detail.process.in-folder': 'PDF in folder',
      'detail.process.not-sent': 'Not sent to accountant (click "📧 Send")',

      // Bottom buttons
      'detail.btn.send-acc': '📧 Send to accountant',
      'detail.btn.already-sent': '✓ Already sent',
      'detail.btn.already-sent.title': 'I already sent it from Gmail or directly',
      'detail.btn.open-pdf': '📄 Open PDF',
      'detail.btn.resend': '↻ Resend',
      'detail.btn.resend-fwd': '↻ Forward again',
      'detail.btn.unmark': '↶ Mark as not sent',
      'detail.btn.unmark.title': 'Remove the "sent" mark',
      'detail.btn.forward-acc': '→ Forward to accountant',
      'detail.attachment.open-drive': 'Open in Drive →',
      'detail.choose': 'Select an item',
      'inbox.missing-total': '{count} payments without invoice (total)',
      // Demo content
      'demo.svc.claude-pro': 'Claude Pro — monthly subscription',

      // Months
      'month.1': 'January',
      'month.2': 'February',
      'month.3': 'March',
      'month.4': 'April',
      'month.5': 'May',
      'month.6': 'June',
      'month.7': 'July',
      'month.8': 'August',
      'month.9': 'September',
      'month.10': 'October',
      'month.11': 'November',
      'month.12': 'December',
      'month.1.short': 'Jan',
      'month.2.short': 'Feb',
      'month.3.short': 'Mar',
      'month.4.short': 'Apr',
      'month.5.short': 'May',
      'month.6.short': 'Jun',
      'month.7.short': 'Jul',
      'month.8.short': 'Aug',
      'month.9.short': 'Sep',
      'month.10.short': 'Oct',
      'month.11.short': 'Nov',
      'month.12.short': 'Dec',
    }
  };

  // ── API ──
  function getLocale() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored && DICT[stored]) return stored;
    } catch (_) {}
    return DEFAULT;
  }

  function setLocale(loc) {
    if (!DICT[loc]) return;
    try { localStorage.setItem(STORAGE_KEY, loc); } catch (_) {}
    apply();
    // Update <html lang> i window event tako da druge skripte mogu reagirati
    document.documentElement.setAttribute('lang', loc);
    window.dispatchEvent(new CustomEvent('libro:locale-change', { detail: { locale: loc } }));
  }

  function t(key, fallback) {
    const loc = getLocale();
    const v = DICT[loc] && DICT[loc][key];
    if (v != null) return v;
    if (DICT.hr && DICT.hr[key]) return DICT.hr[key];
    return fallback != null ? fallback : key;
  }

  // Interpolacija: t('inbox.subtitle', '', { newCount: 0, pendingCount: 1 })
  function tf(key, params, fallback) {
    let s = t(key, fallback != null ? fallback : key);
    if (params && typeof params === 'object') {
      Object.keys(params).forEach(k => {
        s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), String(params[k]));
      });
    }
    return s;
  }

  // Lokalizirano ime mjeseca (idx 0-based ili 1-based — auto-detect; 0 = January).
  function monthName(idx, short) {
    let i = Number(idx);
    if (i >= 0 && i <= 11) i = i + 1;
    if (i < 1 || i > 12) return '';
    return t('month.' + i + (short ? '.short' : ''), '');
  }

  // Relative day label za "Plaćeno X" cards
  function relativeDays(daysAgo) {
    const n = Math.max(0, Math.round(daysAgo));
    if (n === 0) return t('pending.today', 'danas');
    if (n === 1) return t('pending.days-ago-1', 'prije 1 dan');
    return tf('pending.days-ago', { n }, 'prije ' + n + ' dana');
  }

  function apply(root) {
    root = root || document;
    root.querySelectorAll('[data-i18n]').forEach(el => {
      const k = el.getAttribute('data-i18n');
      el.textContent = t(k, el.textContent);
    });
    root.querySelectorAll('[data-i18n-html]').forEach(el => {
      const k = el.getAttribute('data-i18n-html');
      el.innerHTML = t(k, el.innerHTML);
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const k = el.getAttribute('data-i18n-placeholder');
      el.setAttribute('placeholder', t(k, el.getAttribute('placeholder') || ''));
    });
    root.querySelectorAll('[data-i18n-title]').forEach(el => {
      const k = el.getAttribute('data-i18n-title');
      el.setAttribute('title', t(k, el.getAttribute('title') || ''));
    });
    root.querySelectorAll('[data-i18n-aria]').forEach(el => {
      const k = el.getAttribute('data-i18n-aria');
      el.setAttribute('aria-label', t(k, el.getAttribute('aria-label') || ''));
    });
    // <title>
    const titleEl = root.querySelector('title[data-i18n]');
    if (titleEl) titleEl.textContent = t(titleEl.getAttribute('data-i18n'), titleEl.textContent);
  }

  // Public API
  window.LibroI18N = {
    t,
    tf,
    monthName,
    relativeDays,
    getLocale,
    setLocale,
    apply,
    toggle() { setLocale(getLocale() === 'hr' ? 'en' : 'hr'); }
  };
  window.t = t;  // shorthand
  window.tf = tf;

  // Auto-apply nakon DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => apply());
  } else {
    apply();
  }

  // Set lang attribute
  document.documentElement.setAttribute('lang', getLocale());
})();
