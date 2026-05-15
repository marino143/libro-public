# Workflows — kako se libro koristi

## Bootstrap (prvi put, ili nakon reboot-a)

```bash
cd "/Users/marinoglazarair/Documents/Co Work/racunovodstvo"
./rebuild.sh
```

Što radi `rebuild.sh`:
1. `node local-libro.mjs` — regeneriraj libro-data.json
2. Ako port 8765 slobodan → pokreni `node libro-server.mjs &` u pozadini
3. Ispiši URL: http://localhost:8765/racunovodstvo-dashboard.html

Ako Python `http.server` ikad zauzme port 8765:
```bash
lsof -ti:8765 | xargs kill
./rebuild.sh
```

---

## Dnevni workflow: novi račun iz Gmaila

**Opcija A: Preko dashboarda (preferirano)**
1. Otvori dashboard → bilo koji view
2. Klikni `+ Račun` (bottom-right u inbox view) ili na missing TX → `+ PDF`
3. Odaberi PDF iz Downloads
4. Unesi: Dobavljač, Razdoblje (yyyy-MM), Godina, Scope (FIRMA)
5. Klikni "Uploadaj"
6. Server sprema u `Invoice 2026/Placanje MMM YY/Supplier/`
7. Auto rebuild → UI refresh

**Opcija B: Direktni drop u folder**
1. Drop PDF u `Invoice 2026/Placanje MMM YY/Supplier/` (ili kreiraj folder ako treba)
2. U dashboardu → Postavke → "↻ Rebuild" (ili `./rebuild.sh` u terminalu)

---

## Dnevni workflow: novi bankovni izvod iz HPB

1. HPB netbanking → Računi → Izvodi → preuzmi XML (i PDF ako želiš)
2. Opcija A — preko aplikacije:
   - Dashboard → Transakcije → `+ Izvod` (gore desno)
   - Odaberi više XML-ova odjednom (Cmd+klik)
   - Klikni "Uploadaj sve"
3. Opcija B — drop direktno u `IZVODI CO 2026/` + rebuild

Nakon uploada:
- XML se parsira (regex camt.053)
- Transakcije se match-aju s invoice-ima (invoice# u opisu + keyword matching)
- Dashboard pokazuje: missing · matched · forwarded · incoming

---

## Dnevni workflow: označi transakciju

Na **Transakcije → ⚠ Fali PDF** tabu, svaki red ima 3 dugmeta:

| Dugme | Action | Kada |
|-------|--------|------|
| **+ PDF** | Otvara upload modal, prefilled podaci | Kad imaš PDF u Downloads |
| **📧** | Označi kao "poslano iz Gmaila" | Kad si poslao iz Gmaila BEZ local PDF-a |
| **○** | Ignoriraj (ne treba račun) | Kad je HPB fee, porez, trajni nalog |

---

## Dnevni workflow: pošalji račun knjigovodstvu

**Preferred:** iz dashboarda, Mail.app compose s attachmentom.

1. Dashboard → Inbox → **→ Čeka slanje** tab (ili klikni "→ Čeka slanje" u sidebaru)
2. Klikni na prvi račun u listi
3. Desno detail panel → klikni **"📧 Pošalji knjigovodstvu"** (narančasti badge)
4. Mail.app se otvara sa:
   - To: tvoj `accounting.eRacuniInbox` ili `accounting.primaryEmail` iz `libro-config.json`
   - Subject: `[libro.] Supplier · filename · YYYY-MM`
   - Body: auto-generiran
   - **PDF attachiran** ✓
5. **Provjeri From account** u Mail.app (ako imaš više Gmail accounata, izaberi pravi)
6. Klikni Send
7. Dashboard nakon 3s pita "Jesi li poslao?" → OK → status = poslan
8. Alternativno: "✓ Već poslano" ako ručno bez Mail.app

**Bulk za starije mjesece:**
- Na "→ Čeka slanje" tabu → dugme "✓ Označi starije mjesece kao poslano"
- Sve invoice-e iz mjeseci prije current month označava retroactive

---

## Dnevni workflow: putni nalog

1. Dashboard → sidebar → **✈ Putni nalog**
2. Forma:
   - Broj naloga (auto-generira se: `001/2026`, `002/2026`, ...)
   - Datum izdavanja, osoba, svrha
   - Polazak / odredište / vrijeme / prijevoz
   - Broj km + cijena po km (default 0.50)
   - Broj dnevnica + iznos (default 30€ za tuzemstvo)
   - Cestarina / parking / gorivo / smještaj / reprezentacija / ostalo
   - Napomene
3. Live računanje totala (km × rate + dnevnice × rate + ostali)
4. Akcije:
   - **💾 Spremi + PDF** — zapiše JSON + HTML u `Invoice 2026/Putni nalozi/`, otvori preview
   - **👁 Pregled za ispis** — samo preview (ne sprema)
   - **📧 Pošalji knjigovodstvu** — sprema + mailto: link (ti attachaš PDF)
   - **✕ Reset** — isprazni formu

Prethodni nalozi su ispod forme, klik 📝 za edit ili 👁 za print preview.

---

## Nedjeljni workflow: cleanup

1. `git status` i `git log --oneline -20` da vidiš što je dodano
2. Provjeri **CHANGELOG.md** — ispuni sve nezapisane izmjene
3. Dashboard → Transakcije → Fali PDF
   - Za svaki: ignoriraj (○), uploadaj (+ PDF), ili označi poslano (📧)
4. Inbox → Čeka slanje → pošalji sve nove
5. Outgoing → Novi izlazni račun ako treba napisati nove fakture klijentima
6. (Opcijski) commit `libro-*.json` annotations kao backup (file-based, pogodno za git)

---

## Stvaranje izlaznog računa klijentu (Novi izlazni račun)

Jedina preostala Apps Script functionality, ali nije još integrirano u local flow.

Trenutno:
1. Dashboard → Novi izlazni račun
2. Popuni formu (klijent, stavke, iznos, PDV)
3. ~~Generate XML + pošalji knjigovodstvu~~ — **ne radi bez Apps Script**-a

**TODO:** portaj outgoing invoice generation u local flow. Low priority — user uglavnom radi izlazne u e-računi portalu.

---

## Troubleshooting

### Server nije up

```bash
curl http://localhost:8765/api/status
# → "Failed to connect" ili "Empty reply"
```

Pokreni:
```bash
lsof -ti:8765 | xargs kill 2>/dev/null
cd "/Users/marinoglazarair/Documents/Co Work/racunovodstvo"
node libro-server.mjs &
```

### libro-data.json ne postoji ili prazan

```bash
node local-libro.mjs
```

Provjeri izlaz. Ako kaže "invoice count: 0":
```bash
ls "Invoice 2026/"
# Provjeri je li Drive sync ok
```

### Transakcije = 0

```bash
ls "IZVODI CO 2026/"*.xml | wc -l
# Trebao bi biti > 50
```

Ako nula: Drive sync ne radi, otvori Google Drive for Desktop app.

### Upload ne funkcionira

Otvori DevTools → Network. Klik na "+ Račun":
- Ako nema POST /api/upload → client-side JS error, reload
- Ako POST ide ali 500 → provjeri terminal gdje je server pokrenut (Node traceback)
- Ako POST 200 ali ništa u folderu → provjeri `path` u response-u

### Upload modal se ne otvara

Vjerojatno je modal unutar section koja ima `display:none`. Provjeri:
```bash
grep -n 'id="uploadModal"' racunovodstvo-dashboard.html
```
Mora biti BLIZU kraja fajla (prije `</body>`), NE unutar `<section>`.

### Match false-positive (pogrešan PDF povezan s TX)

Normalno. Matcher preferira invoice# > keyword. Ako keyword match je previše agresivan:
- Editaj `tokensFromSupplier` u `local-libro.mjs` → dodaj stop-word
- Ili refine `matchTransactions` da zahtijeva i period match

---

## Data recovery

Ako slučajno izbrišeš `libro-data.json`:
```bash
node local-libro.mjs
# Rebuild iz izvora. Nema data gubitka.
```

Ako izbrišeš annotation file (npr. `libro-forwarded.json`):
- **User-marked states se gube.** Pokušaj Git restore:
  ```bash
  git checkout libro-forwarded.json
  ```
- Ako nema Git-a → moraš ponovo označiti TX-ove ručno.

**Preporuka:** redoviti git commit anotacija:
```bash
git add libro-*.json CHANGELOG.md
git commit -m "state snapshot $(date +%Y-%m-%d)"
```
