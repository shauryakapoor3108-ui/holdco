#!/usr/bin/env bash
# live-m8-deck-feed.sh - M8 live proof (run manually: `bash scripts/live-m8-deck-feed.sh`).
#
# The deck's complete data path, live and with zero real data: `holdco obs` +
# `holdco replay` (deck demo mode, docs/DECK.md). The synthetic five-card
# fixture is ingested through the real POST path, lands in SQLite (run
# rollups queryable), and every event is delivered over the live SSE stream -
# exactly what the externally-built deck UI will consume. No model spend.
set -euo pipefail

HOLDCO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d /tmp/holdco-live-m8-XXXXXX)"
PORT=43931
echo "workdir: $WORK"

node "$HOLDCO_ROOT/src/cli.ts" obs --port "$PORT" --db "$WORK/obs.db" --token demo >"$WORK/obs.log" 2>&1 &
OBS=$!
trap 'kill $OBS 2>/dev/null || true' EXIT
sleep 1.5

curl -sN "http://127.0.0.1:$PORT/stage-events/stream?token=demo" >"$WORK/sse.log" &
SSE=$!
sleep 0.5

node "$HOLDCO_ROOT/src/cli.ts" replay --obs-url "http://127.0.0.1:$PORT" --obs-token demo --speed 0
sleep 1
kill $SSE 2>/dev/null || true

RUNS="$(curl -s "http://127.0.0.1:$PORT/runs?token=demo&limit=20")"
CARDS=$(echo "$RUNS" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(new Set(d.runs.map(r=>r.card_id)).size)")
FRAMES=$(grep -c '^event: stage' "$WORK/sse.log" || echo 0)
TOTAL=$(grep -c . "$HOLDCO_ROOT/deck/fixtures/demo-board.jsonl")

echo
echo "── run rollups ─────────────────────────────────────────"
echo "$RUNS" | head -c 600; echo
echo
echo "cards in rollup: $CARDS · SSE frames: $FRAMES / $TOTAL fixture events"
if [ "$CARDS" -ge 5 ] && [ "$FRAMES" -eq "$TOTAL" ]; then
	echo "✅ M8 LIVE PROOF PASSED - synthetic board ingested, rollups queryable, full replay delivered over live SSE."
	rm -rf "$WORK"
else
	echo "❌ M8 LIVE PROOF FAILED - inspect $WORK"
	exit 1
fi
