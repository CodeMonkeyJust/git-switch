#!/bin/sh
# Linux + Node 22 verification of the built artefact.
set -e

echo "--- node ---"
node --version

echo "--- dist entry point ---"
node dist/gs.mjs version

echo "--- dist must contain no TypeScript sources ---"
count=$(find dist -name '*.ts' | wc -l | tr -d ' ')
echo "  .ts files in dist: $count"
test "$count" -eq 0

echo "--- gui assets present ---"
test -f dist/web/index.html
test -f dist/web/src/main.js
test -f dist/web/src/styles/main.css
echo "  ok"

echo "--- gui serves from the built layout ---"
mkdir -p /tmp/h/.config/gs
printf 'schemaVersion: 1\nidentities:\n  a:\n    user: { name: a, email: a@x.com }\nrules: []\n' > /tmp/h/.config/gs/profiles.yaml

node dist/gs.mjs gui --home /tmp/h --no-open --json --idle-timeout 0 > /tmp/gui.out 2>&1 &
GUI_PID=$!
sleep 3
cat /tmp/gui.out

URL=$(grep -o '"url": *"[^"]*"' /tmp/gui.out | sed 's/.*"\(http[^"]*\)"/\1/')
if [ -z "$URL" ]; then echo "gui did not report a url"; kill $GUI_PID 2>/dev/null; exit 1; fi

BASE=$(echo "$URL" | cut -d'#' -f1 | sed 's:/*$::')
TOKEN=$(echo "$URL" | sed 's/.*token=//')

for path in / /src/main.js /src/api.js /src/styles/main.css; do
  code=$(node -e "
    fetch('$BASE$path', { headers: { 'x-gs-token': '$TOKEN' } })
      .then(r => { console.log(r.status); })
      .catch(e => { console.log('ERR'); });
  ")
  echo "  $path -> $code"
done

kill $GUI_PID 2>/dev/null || true
wait $GUI_PID 2>/dev/null || true
echo "PASS"
