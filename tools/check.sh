#!/usr/bin/env bash
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail=0

echo "== manifest.json =="
if python3 -m json.tool "$ROOT/manifest.json" >/dev/null 2>&1; then
  echo "OK manifest.json"
else
  echo "FAIL manifest.json is not valid JSON"; fail=1
fi

echo "== JS syntax =="
while IFS= read -r f; do
  tmp="$(mktemp --suffix=.mjs)"
  cp "$f" "$tmp"
  if node --check "$tmp" >/dev/null 2>&1; then
    echo "OK $f"
  else
    echo "FAIL syntax: $f"; node --check "$tmp"; fail=1
  fi
  rm -f "$tmp"
done < <(find "$ROOT/src" -name '*.js' 2>/dev/null)

echo "== remote scripts (must be none) =="
if grep -rnE 'https?://[^"'"'"' )]+\.js' "$ROOT/src" "$ROOT/manifest.json" 2>/dev/null; then
  echo "FAIL remote script reference found"; fail=1
else
  echo "OK no remote scripts"
fi

echo "== provider hosts (OpenAI and DeepSeek only) =="
if grep -rhoE 'https://[a-z0-9.-]+' "$ROOT/src" 2>/dev/null \
   | sort -u \
   | grep -vE 'api\.openai\.com|api\.deepseek\.com|^$'; then
  echo "FAIL: unexpected provider host"; fail=1
else
  echo "OK provider hosts"
fi

echo "== retired transcription runtime (Gemini must be absent from source/manifest) =="
if grep -rniE 'gemini|generativelanguage' "$ROOT/src" "$ROOT/manifest.json" 2>/dev/null; then
  echo "FAIL: retired transcription runtime reference remains"; fail=1
else
  echo "OK no Gemini runtime references"
fi

echo "== expected files =="
for f in \
  manifest.json \
  src/background/service-worker.js \
  src/offscreen/offscreen.html \
  src/offscreen/offscreen.js \
  src/sidepanel/sidepanel.html \
  src/sidepanel/sidepanel.css \
  src/sidepanel/sidepanel.js \
  src/lib/messages.js \
  src/lib/settings.js \
  src/lib/models.js \
  src/lib/net.js \
  src/lib/store.js \
  src/lib/templates.js \
  src/lib/providers/transcription/index.js \
  src/lib/providers/transcription.openai.js \
  src/lib/providers/notes.deepseek.js ; do
  if [ -f "$ROOT/$f" ]; then echo "OK $f"; else echo "MISSING $f"; fail=1; fi
done

echo
[ "$fail" -eq 0 ] && echo "ALL STATIC CHECKS PASSED" || echo "STATIC CHECKS FAILED"
exit $fail
