# libro · Setup vodič

Detaljan vodič kroz prvo pokretanje. Za TL;DR pogledaj [README.md](./README.md).

---

## Što ti treba prije početka

- **macOS** (radi i na Linuxu, ali macOS app + Apple Mail integracija je macOS-only)
- **Node.js v18+** — provjera: `node --version`
- **Folder za račune** — može biti bilo gdje na disku (preporuka: u Documents/)
- *(opcionalno)* Anthropic API key za AI — https://console.anthropic.com
- *(opcionalno)* Google account ako želiš Gmail sync

---

## Korak 1 — Pokreni server

```bash
cd "libro public"
node libro-server.mjs
```

Vidjet ćeš:

```
▸ libro server running
  ⚠ First-run: setup wizard će se otvoriti automatski
  http://localhost:8765/setup.html
  root: /Users/.../libro public
```

Otvori `http://localhost:8765/` u browseru — automatski preusmjerava na setup.

---

## Korak 2 — Setup wizard

### 2.1 — Folder za račune

Najvažniji korak. Trebaš apsolutnu putanju do foldera gdje su (ili će biti)
tvoji PDF-ovi. Primjer:

```
/Users/ime/Documents/Računi
```

Default-i za podfoldere su:
- `Invoice {year}` — dolazni računi
- `Izvodi {year}` — bankovni izvodi
- `Izlazni racuni {year}` — izlazni računi
- `Knjigovodstvo dokumenti` — dokumenti od knjigovođe

`{year}` se zamjenjuje trenutnom godinom (2026, 2027, ...). Ako koristiš
drugačiju konvenciju, samo promijeni vrijednost — npr. `Bank {year}` ili `Statements/{year}`.

**Pro tip:** ako koristiš Google Drive / Dropbox / iCloud Drive, postavi
folder unutar synciranog foldera. libro radi lokalno, ali bilo koji cloud
sync će automatski uploadati promjene.

### 2.2 — Tvoji podaci

Pojavljuju se na:
- Izlaznim računima (XML/HTML/PDF)
- Putnim nalozima (PDF)
- Email body-ju kad šalješ knjigovođi

Sve je opcionalno — kasnije popuni u Settings tabu.

### 2.3 — AI (Claude)

Ako želiš da libro:
- Parsira PDF račune (izvuče kupca, iznos, PDV)
- Inteligentno matcha uplate s računima
- Razgovara s tobom o financijama ("Koliko sam ovaj mjesec dao za hosting?")

...uključi AI. Trebaš Anthropic API key.

**Kako dobiti key:**
1. Otvori https://console.anthropic.com/settings/keys
2. Sign up + kreditna kartica (pay-per-use)
3. "Create Key", kopiraj
4. Paste u wizard

Wizard te uputi da spremiš key u `.env` (jer wizard ne pretpostavlja root
permissions). Otvori `.env` u editoru i dodaj:

```
ANTHROPIC_API_KEY=sk-ant-api03-...
```

Restartaj server (`Ctrl+C` u Terminalu, pa `node libro-server.mjs` opet).

### 2.4 — Knjigovodstvo (opcionalno)

Ako šalješ izvode/račune knjigovođi:

- **Primarni email** — gdje šalješ
- **Sekundarni emaili** — bivši knjigovođe, druga osoba u firmi (libro traži u Gmailu i tu)
- **e-Računi inbox** — ako koristiš e-racuni.com portal, OIB@e-racuni.com je tvoj inbox

Ako ne šalješ nikome — preskoči. libro je i samo za personal tracking ok.

### 2.5 — Banka

- **Naziv** — npr. "HPB", "PBZ", "Erste"
- **Broj računa** — bez razmaka (samo brojevi)
- **Email banke** — onaj sa kojeg ti stižu izvodi. Za HPB: `kontakt.centar@hpb.hr`
- **Parser**:
  - **Auto** — pokušaj XML, fallback na AI
  - **camt.053 XML** — sve veće hrvatske banke šalju ovaj format
  - **AI** — bilo koja banka, ali svaki izvod košta par centi

Preskoči ako ne znaš — popunit ćeš kasnije.

---

## Korak 3 — Spremi i otvori dashboard

Klikni **"Spremi i otvori dashboard"**. Server upiše `libro-config.json`,
postavi `setupCompleted: true`, redirektaj na `/dashboard.html`.

Prvi screen će reći "Nema podataka — Rebuild" — to je normalno jer nisi
još stavio PDF-ove u folder. Dodaj par PDF-ova pa klikni **Rebuild** u
gornjem desnom kutu.

---

## Korak 4 — Gmail OAuth (opcionalno)

Ako želiš automatsko skidanje izvoda iz Gmaila:

```bash
node setup-gmail-auth.mjs
```

Skripta:
1. Otvara Google OAuth URL
2. Login, daj permisije za "Read Gmail" i "Modify labels"
3. Paste auth code
4. Sprema `GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN` u `.env`

Drugi account:
```bash
node setup-gmail-auth.mjs --secondary --hint=drugi-email@gmail.com
```

**Gotchas:**
- Google OAuth consent screen u "Testing" mode → token istječe svakih 7 dana.
  Da to izbjegneš: u Google Cloud Console → OAuth → **Publish App**.
- Ako klikne krivi account, pokreni opet s `--hint=ispravni-email`.

---

## Korak 5 — macOS native app (opcionalno)

Umjesto Chrome taba, možeš imati native macOS app:

```bash
./macos-app/build.sh
```

Build kreira `/Applications/libro.app` (89 KB). Otvori normalno iz
Applications foldera ili Spotlightom. Server se auto-pokreće ako nije
running.

---

## Promjene nakon setup-a

### Mijenjaj config bez wizarda

Otvori `libro-config.json` u editoru i edit-aj. Server čita kroz ~2s cache TTL,
pa dashboard reflectira promjenu skoro odmah.

### Ponovi wizard

Otvori `http://localhost:8765/setup.html` direktno. Wizard pre-fill-a iz
postojećeg `libro-config.json` — možeš mijenjati i spremati ponovo.

### Reset (kao da nisi nikad pokrenuo)

```bash
rm libro-config.json libro-data.json libro-*.json
```

Ovo briše **runtime state** ali ne diraju **PDF-ove ni izvode u folderu**.
Sljedeće pokretanje server-a otvara setup wizard od početka.

---

## Backup što treba čuvati

```
libro-config.json       ← config (firma, paths)
.env                    ← API keys / OAuth tokens
libro-forwarded.json    ← označeni TX-ovi "poslano iz Gmaila"
libro-ignored.json      ← označeni TX-ovi "ignoriraj"
libro-emails-sent.json  ← oznake "poslano knjigovodstvu"
libro-clients.json      ← spremljeni klijenti (autocomplete)
```

`libro-data.json` se može regenerirati s `npm run rebuild`, nije važan za
backup.

PDF-ovi i XML-ovi u folderu — backup-aj ih kako bilo koji drugi važan
folder (Time Machine, cloud sync, vanjski disk).

---

## FAQ

**Mogu li imati dva libra paralelno (npr. dvije firme)?**
Da. Klone-aj folder dva puta, svaki ima svoj `libro-config.json` i svoj port.
Drugi pokreni s `node libro-server.mjs 8766`.

**Mogu li migrirati postojeće PDF-ove?**
Da — samo ih spremi u `<root>/Invoice 2026/Placanje MMM YY/Supplier/file.pdf`.
Rebuild će ih pokupiti.

**Što ako mijenjam banku usred godine?**
Setup wizard → Step 5 → promijeni naziv + broj. Stari izvodi i dalje rade
(pattern je za fileove već u folderu), novi će biti detektirani s novom
bankom.

**Da li libro radi offline?**
Da — ali AI parsing zahtjeva internet (zove Anthropic API). Folder skeniranje,
matching, dashboard radi 100% offline.

**Zašto su neki podaci u `.env` a neki u `libro-config.json`?**
- **`.env`**: secrets (API key-evi, OAuth refresh tokens) — nikad ne ide u git
- **`libro-config.json`**: settings (paths, firma, knjigovodstvo) — može u git ako želiš (ali default `.gitignore` ga ignorira)

---

Pitanja, problemi: pogledaj sekciju **Troubleshooting** u README.md ili
otvori issue ako koristiš git mirror.
