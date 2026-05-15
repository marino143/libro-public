#!/bin/bash
# libro — rebuild + ensure server running
# ───────────────────────────────────────

set -e
cd "$(dirname "$0")"

# First-run guard: ako libro-config.json ne postoji, samo pokreni server pa
# user-a vodi setup wizard. Bez rebuild-a — nema još foldera za skenirati.
if [ ! -f libro-config.json ]; then
  echo "▸ libro — first run (setup wizard će se otvoriti automatski)"
  if ! lsof -ti:8765 > /dev/null 2>&1; then
    nohup node libro-server.mjs > /tmp/libro-server.log 2>&1 &
    sleep 1
  fi
  echo "✓ Otvori: http://localhost:8765/"
  exit 0
fi

echo "▸ libro rebuild"
node local-libro.mjs

echo ""

# Pokreni libro-server.mjs ako ne radi
if ! lsof -ti:8765 > /dev/null 2>&1; then
  echo "▸ Pokrećem libro-server.mjs u pozadini…"
  nohup node libro-server.mjs > /tmp/libro-server.log 2>&1 &
  sleep 1
fi

echo "✓ Ready"
echo "  → http://localhost:8765/"
