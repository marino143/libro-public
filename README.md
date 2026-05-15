# libro.

Lokalno osobno računovodstvo. Skenira PDF račune i bankovne izvode iz lokalnog
foldera, matcha uplate s računima, AI parsira nepoznate dokumente, i opcionalno
forwardira knjigovođi.

Sve ostaje lokalno — folderi na tvom disku, server na localhost-u, AI poziva
direktno Anthropic API. Bez SaaS-a, bez čuvanja podataka na tuđim serverima.

---

## Brzi start

```bash
# 1. Klikni install (ili: cd u folder)
cd "libro public"

# 2. Pokreni server
node libro-server.mjs

# 3. Otvori dashboard u browseru
open http://localhost:8765
```

Pri prvom pokretanju otvorit će se **setup wizard** koji te vodi kroz:

1. **Folder za račune** — gdje su tvoji PDF-ovi (lokalno)
2. **Tvoji podaci** — naziv firme, OIB, IBAN (za izlazne račune i putne naloge)
3. **AI** — uključi Claude za automatsko parsiranje računa i matching (opcionalno)
4. **Knjigovodstvo** — auto-forward izvoda na email knjigovođe (opcionalno)
5. **Banka** — naziv + broj računa, za precizan parser bank izvoda

Kad spremiš, prebacuje te na dashboard.

---

## Struktura foldera

Folder strukturu definiraš sam u setup wizardu. Default:

```
<korijenski folder>/
├── Invoice 2026/                      ← dolazni računi (PDF)
│   └── Placanje Apr 26/
│       └── Supplier name/
│           └── racun-123.pdf
├── Izvodi 2026/                       ← bankovni izvodi (XML camt.053 + PDF)
├── Izlazni racuni 2026/               ← izlazni računi koje ti izdaješ
└── Knjigovodstvo dokumenti/           ← dokumenti od knjigovođe
```

Folderi se kreiraju automatski kako ih treba.

---

## Što libro radi

| Feature | Opis |
|---------|------|
| **Skeniranje** | Prolazi kroz folder, indeksira sve PDF-ove i XML-ove |
| **Matching** | Spaja transakcije iz izvoda s računima u folderu (po iznosu, datumu, dobavljaču) |
| **AI parsing** | Claude Vision parsira PDF račune (kupac, iznos, PDV, stavke) |
| **Izlazni računi** | Generator sa XML / HTML / PDF export |
| **Putni nalozi** | Forma + AI izvještaj + PDF/XML za knjigovodstvo |
| **Knjigovodstvo flow** | Auto-forward izvoda i računa knjigovođi (Gmail OAuth ili Apple Mail) |
| **AI chat** | "Koliko sam potrošio na X?" — odgovara iz libro-data.json |
| **Dashboard** | Sve na jednom mjestu, lokalni HTML, bez login-a |

---

## Konfiguracija — gdje je što

| Fajl | Što sadrži |
|---|---|
| `libro-config.json` | **User config** (firma, paths, knjigovodstvo) — pravi setup wizard |
| `libro-config.example.json` | Schema/defaults (read-only template) |
| `.env` | **Secrets** (Anthropic API key, Gmail OAuth tokens) |
| `.env.example` | Template (kopiraj u `.env`) |
| `libro-data.json` | **Generated** — output od `local-libro.mjs` (rebuild-a dashboard) |
| `libro-*.json` | Runtime state (forwarded marks, ignored TX-ovi, sent emails, ...) |

Mijenjati config možeš:
- **Setup wizard** — `http://localhost:8765/setup.html` (radi i nakon prvog setup-a)
- **Settings tab** — u dashboardu
- **Ručno** — edit `libro-config.json` (server detektira promjenu kroz ~2s cache TTL)

---

## Opcionalne integracije

### Gmail OAuth (sync iz inboxa)

Ako želiš da libro skida bankovne izvode direktno iz Gmaila:

```bash
node setup-gmail-auth.mjs
# slijedi upute — otvori URL u browseru, paste auth code
```

Skripta sprema 3 vrijednosti u `.env`:
- `GMAIL_CLIENT_ID`
- `GMAIL_CLIENT_SECRET`
- `GMAIL_REFRESH_TOKEN`

Drugi account (secondary):
```bash
node setup-gmail-auth.mjs --secondary --hint=tvoj-drugi-email@gmail.com
```

### Anthropic (AI parsing)

1. Dobij key na: https://console.anthropic.com/settings/keys
2. U `.env`: `ANTHROPIC_API_KEY=sk-ant-...`
3. U Settings dashboard: uključi "AI" toggle

Cost: ~5-15 EUR/mj za prosjeg use-case. Limit u `libro-config.json` →
`ai.dailyLimitUSD` (default 2 USD).

---

## Skripte

```bash
npm start          # pokreni server (port 8765)
npm run rebuild    # regeneriraj libro-data.json iz foldera
npm run dev        # rebuild + start (combo)
```

Server također može pokrenuti rebuild kroz `POST /api/rebuild` — koristi se
gumb "Rebuild" u dashboardu.

---

## Native macOS app (opcionalno)

Source je u `macos-app/libro-app.swift` (Swift WKWebView, ~89 KB).
Build:

```bash
./macos-app/build.sh
# Instalira u /Applications/libro.app
```

Auto-launches server ako nije pokrenut (kroz launchctl).

---

## Privatnost

- **Sve lokalno**: serveri rade na `localhost:8765`, file storage je u tvojim
  folderima na disku, baze podataka **nema**.
- **AI poziva**: kad AI parsira PDF, sadržaj se šalje na Anthropic API (Claude).
  Ako ne uključiš AI, nikakvi podaci ne napuštaju tvoje računalo.
- **Gmail poziva**: ako uključiš Gmail OAuth, libro čita inbox direktno preko
  Google API-ja. Token je u tvom `.env` fajlu, nikoga drugog ne vidi.
- **Telemetrija**: nema je. Nikakvi analyticsi, nikakvi pingovi prema vani.

---

## Troubleshooting

**Dashboard se otvori prazan**
Setup nije završen ili config je oštećen. Idi na `http://localhost:8765/setup.html`.

**"Folder za račune je obavezan"**
Step 1 setupa traži apsolutnu putanju. Ako ne znaš svoju: u Terminalu otvori
folder, pa `pwd`.

**AI ne radi**
- API key u `.env`? `cat .env | grep ANTHROPIC`
- Server restartan nakon edita `.env`? `pkill -f libro-server && npm start`
- Limit prekoračen? Check `libro-claude-usage.json`.

**Bank statements ne dolaze**
- Gmail OAuth setup-an? `node setup-gmail-auth.mjs`
- Email banke u config-u? Setup wizard → Step 5 → "Email banke"
- HPB primjer: `kontakt.centar@hpb.hr`

---

## Stack

- **Server**: Node.js + native `http` (bez Express-a)
- **Frontend**: HTML + vanilla JS (jedan file, ~358 KB)
- **AI**: Anthropic Claude (Sonnet/Haiku/Opus) — opcionalno
- **Storage**: lokalni filesystem + JSON fajlovi
- **macOS app**: Swift + WKWebView

Bez dep-a, bez DB-a, bez SaaS-a. Sve fits u par MB.

---

## License

Personal use. Adapt slobodno za svoju situaciju.
